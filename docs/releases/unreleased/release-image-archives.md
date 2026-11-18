## Improved

- Every release now also carries the signed container image as a file, one per processor
  (`kalzit-<version>-image-linux-amd64.tar.gz` and `-linux-arm64.tar.gz`, each with its SHA-256),
  for servers that cannot reach ghcr.io: `docker load` and `podman load` read it, and it is checked
  against the signed image by its SHA-256 and config digest
  ([Installation](../../guide/installation.md#loading-the-image-from-the-release)).
