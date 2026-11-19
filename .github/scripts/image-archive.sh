#!/usr/bin/env bash
# Writes one platform's image of a pushed multi-platform index as a gzip-compressed
# docker-archive, which `docker load` and `podman load` read, and checks it before anything is
# published (release.yml, job `image-archive`):
#
#   image-archive.sh REPOSITORY DIGEST ARCH VERSION OUT_DIR
#   image-archive.sh ghcr.io/mousewerk/kalzit sha256:<64 hex> amd64 0.7.3 dist
#
# 1. reads the index at exactly DIGEST and takes its single linux/ARCH image (the attestation
#    entries of the index have no platform and are skipped), then that image's manifest and its
#    config digest; every document read is checked against the digest it was asked for;
# 2. copies that image by digest with skopeo into a docker-archive tagged REPOSITORY:VERSION,
#    then gzips it without name or time stamp, so the same image always gives the same file;
# 3. checks the archive: one image, the expected tag, and a config whose SHA-256 is the
#    manifest's config digest; then loads it with `docker load` and checks the loaded image's
#    platform and config digest, and that it runs and names VERSION (only when the runner has the
#    same processor, so nothing is emulated);
# 4. writes kalzit-VERSION-image-linux-ARCH.tar.gz to OUT_DIR and prints its SHA-256 as
#    `sha256=<hex>` (the release signs both archives' hashes in one checksum file).
#
# Registry credentials come from the Docker configuration (docker login); nothing is uploaded.
# Needs skopeo 1.13 or newer, docker, jq, gzip and sha256sum. Can run on its own against any
# released image for a dry run (workflow image-archive-dry-run.yml).
set -euo pipefail

repository=${1:?usage: image-archive.sh REPOSITORY DIGEST ARCH VERSION OUT_DIR}
digest=${2:?usage: image-archive.sh REPOSITORY DIGEST ARCH VERSION OUT_DIR}
arch=${3:?usage: image-archive.sh REPOSITORY DIGEST ARCH VERSION OUT_DIR}
version=${4:?usage: image-archive.sh REPOSITORY DIGEST ARCH VERSION OUT_DIR}
out_dir=${5:?usage: image-archive.sh REPOSITORY DIGEST ARCH VERSION OUT_DIR}

fail() {
  echo "::error::$1"
  exit 1
}

digest_re='^sha256:[0-9a-f]{64}$'
[[ "$digest" =~ $digest_re ]] || fail "not a sha256 digest: $digest"
[[ "$repository" =~ ^[a-z0-9./_-]+$ ]] || fail "not a lower-case repository: $repository"
case "$arch" in amd64 | arm64) ;; *) fail "unknown architecture: $arch" ;; esac
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "not a version: $version"

# skopeo 1.13 is the one in Ubuntu 24.04; the behaviour the archive depends on (uncompressed
# layers, the config stored as <hex>.json, fixed tar time stamps) is the same since well before.
skopeo_version=$(skopeo --version | awk '{print $3}')
echo "skopeo $skopeo_version, $(docker --version), $(gzip --version | head -n1)"
IFS=. read -r major minor _ <<< "$skopeo_version"
if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 13 ]; }; then
  fail "skopeo $skopeo_version is older than 1.13"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out_dir"

# Docker's configuration holds the login (docker login); skopeo reads that format.
authfile="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
auth=()
if [ -f "$authfile" ]; then
  auth=(--authfile "$authfile")
fi
# Every image is fetched by digest and checked here, and the release workflow verified the
# index's cosign signature first, so skopeo's own signature policy accepts anything; written out
# so no host policy file changes the result.
printf '%s\n' '{"default":[{"type":"insecureAcceptAnything"}]}' > "$work/policy.json"
skopeo_global=(--policy "$work/policy.json")

# The documents are checked against their digests, not only trusted to skopeo.
fetch_raw() {
  local reference=$1 expected=$2 target=$3
  skopeo "${skopeo_global[@]}" inspect --retry-times 3 "${auth[@]}" --raw "docker://$repository@$reference" > "$target"
  [ "sha256:$(sha256sum "$target" | cut -d' ' -f1)" = "$expected" ] ||
    fail "the document at $reference does not match its digest"
}

fetch_raw "$digest" "$digest" "$work/index.json"
case "$(jq -r '.mediaType // empty' "$work/index.json")" in
  application/vnd.oci.image.index.v1+json | application/vnd.docker.distribution.manifest.list.v2+json) ;;
  *) fail "$digest is not an image index" ;;
esac
platform_digest=$(jq -r --arg arch "$arch" '
  [.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch
    and ((.platform.variant // "") == "" or (.platform.variant == "v8" and $arch == "arm64")))]
  | if length == 1 then .[0].digest else error("expected one linux/\($arch) image, found \(length)") end
' "$work/index.json")
[[ "$platform_digest" =~ $digest_re ]] || fail "bad platform digest: $platform_digest"

fetch_raw "$platform_digest" "$platform_digest" "$work/manifest.json"
case "$(jq -r '.mediaType // empty' "$work/manifest.json")" in
  application/vnd.oci.image.manifest.v1+json | application/vnd.docker.distribution.manifest.v2+json) ;;
  *) fail "$platform_digest is not an image manifest" ;;
esac
config_digest=$(jq -r '.config.digest' "$work/manifest.json")
[[ "$config_digest" =~ $digest_re ]] || fail "bad config digest: $config_digest"
config_hex=${config_digest#sha256:}
echo "linux/$arch: manifest $platform_digest, config $config_digest"

tag="$repository:$version"
name="kalzit-$version-image-linux-$arch.tar.gz"
# By digest, never by tag. A docker-archive keeps no signatures; dropping them is said
# explicitly instead of left to skopeo's default.
skopeo "${skopeo_global[@]}" copy --retry-times 3 "${auth[@]}" --remove-signatures \
  "docker://$repository@$platform_digest" "docker-archive:$work/image.tar:$tag"

# The archive itself: one image, our tag, and the config the signed manifest names.
tar -xOf "$work/image.tar" manifest.json > "$work/archive-manifest.json"
jq -e --arg tag "$tag" --arg config "$config_hex.json" '
  length == 1 and .[0].RepoTags == [$tag] and .[0].Config == $config
' "$work/archive-manifest.json" > /dev/null || fail "unexpected archive manifest: $(cat "$work/archive-manifest.json")"
[ "$(tar -xOf "$work/image.tar" "$config_hex.json" | sha256sum | cut -d' ' -f1)" = "$config_hex" ] ||
  fail "the archive's config does not match $config_digest"

# -n leaves out the file name and time, so the bytes depend only on the image.
gzip -n -9 < "$work/image.tar" > "$work/$name"

# As a user loads it. The loaded config digest is read back through `docker save`, which names it
# both with the classic image store (<hex>.json) and with the containerd one (blobs/sha256/<hex>).
if docker image inspect "$tag" > /dev/null 2>&1; then
  fail "$tag is already present in the local Docker; remove it first"
fi
docker load --input "$work/$name"
loaded_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$tag")
[ "$loaded_platform" = "linux/$arch" ] || fail "the loaded image is $loaded_platform, not linux/$arch"
loaded_config=$(docker save "$tag" | tar -xOf - manifest.json | jq -r '.[0].Config')
loaded_config=${loaded_config##*/}
loaded_config=${loaded_config%.json}
[ "$loaded_config" = "$config_hex" ] || fail "the loaded image's config is $loaded_config, not $config_hex"
host_arch=$(docker version --format '{{.Server.Arch}}')
if [ "$host_arch" = "$arch" ]; then
  docker run --rm --pull never --network none "$tag" --version | tee "$work/version.txt"
  grep -qw -- "$version" "$work/version.txt" || fail "the image does not name version $version"
else
  echo "runner is $host_arch: linux/$arch checked by inspection only, not run"
fi
docker image rm "$tag" > /dev/null

mv "$work/$name" "$out_dir/$name"
echo "sha256=$(sha256sum "$out_dir/$name" | cut -d' ' -f1)"
