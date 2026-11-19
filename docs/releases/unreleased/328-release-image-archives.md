## Improved

- Every release now also carries the container image as a file, one per processor
  (`kalzit-<version>-image-linux-amd64.tar.gz` and `-linux-arm64.tar.gz`), for everyone without
  access to ghcr.io and for servers that cannot reach it: `docker load` and `podman load` read it.
  A checksum file signed with cosign by the release workflow (`kalzit-<version>-image-SHA256SUMS`
  and its `.sigstore.json`) ties each archive to the release; its SHA-256 alone only shows that
  the download is complete. With access to ghcr.io, the archive's config digest can also be
  compared with the signed image
  ([Installation](../../guide/installation.md#loading-the-image-from-the-release)).
