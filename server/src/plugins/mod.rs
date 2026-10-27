//! Plugins (docs/ARCHITECTURE.md, "Plugins"). The contract lives in the `kalzit-plugin-api`
//! crate: the data source protocol, the manifest and the signing context. Here is the server's
//! side of it: the server's types in the protocol (`wire`) and the in-process adapter that serves
//! a registered kind through the protocol (`in_process`). The plugin host (processes, transport,
//! sandbox), signature checks and the catalog follow in M4.

pub mod in_process;
#[cfg(test)]
pub(crate) mod test_results;
pub mod wire;
