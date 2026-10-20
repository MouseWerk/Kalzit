use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use granit::config::{Config, LogConfig};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "granit", version, about = "Granit: visualize and analyze your data")]
struct Cli {
    /// Configuration file (default: ./granit.toml, then the system location).
    #[arg(long, short, global = true, env = "GRANIT_CONFIG")]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server (the default).
    Serve,
    /// Read and validate the configuration, then exit.
    CheckConfig,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let config = match Config::load(cli.config.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("granit: configuration error: {e:#}");
            return ExitCode::from(2);
        }
    };
    match cli.command.unwrap_or(Command::Serve) {
        Command::CheckConfig => {
            println!("configuration is valid");
            ExitCode::SUCCESS
        }
        Command::Serve => {
            init_logging(&config.log);
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("granit: cannot start the async runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            match runtime.block_on(granit::server::run(config)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    tracing::error!("{e:#}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

fn init_logging(cfg: &LogConfig) {
    let filter = EnvFilter::try_new(&cfg.level).unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    if cfg.format == "json" {
        builder.json().init();
    } else {
        builder.init();
    }
}
