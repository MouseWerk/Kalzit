//! Compiles the protocol from `proto/` with protox, so the build needs no protoc.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto");
    let descriptors = protox::compile(["kalzit/plugin/datasource/v1/datasource.proto"], ["proto"])?;
    tonic_prost_build::configure()
        .build_transport(false)
        // Maps keep a stable order, as the server's own types do.
        .btree_map(".")
        .compile_fds(descriptors)?;
    Ok(())
}
