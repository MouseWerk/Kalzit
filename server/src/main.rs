use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use kalzit::config::{Config, LogConfig};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "kalzit", version, about = "Kalzit: visualize and analyze your data")]
struct Cli {
    /// Configuration file (default: ./kalzit.toml, then the system location).
    #[arg(long, short, global = true, env = "KALZIT_CONFIG")]
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
    /// Manage the key that encrypts data source secrets.
    Secrets {
        #[command(subcommand)]
        action: SecretsCommand,
    },
}

#[derive(Subcommand)]
enum SecretsCommand {
    /// Re-encrypt every stored secret with a new key. Stop the server first.
    Rotate,
}

fn main() -> ExitCode {
    // One rustls crypto provider for the whole process (ring), before any TLS client or server
    // is built; libraries that would pick another one use this.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cli = Cli::parse();
    let config = match Config::load(cli.config.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("kalzit: configuration error: {e:#}");
            return ExitCode::from(2);
        }
    };
    match cli.command.unwrap_or(Command::Serve) {
        Command::CheckConfig => {
            println!("configuration is valid");
            ExitCode::SUCCESS
        }
        Command::Secrets { action: SecretsCommand::Rotate } => {
            init_logging(&config.log);
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("kalzit: cannot start the async runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            match runtime.block_on(kalzit::secrets::rotate(&config)) {
                Ok(rotation) => {
                    println!("{rotation}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("kalzit: rotating the secrets key failed: {e:#}");
                    ExitCode::FAILURE
                }
            }
        }
        Command::Serve => {
            init_logging(&config.log);
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("kalzit: cannot start the async runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            match runtime.block_on(kalzit::server::run(config)) {
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
    let filter = EnvFilter::try_new(&cfg.level).expect("log.level is checked in Config::validate");
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    if cfg.format == "json" {
        builder.json().init();
    } else {
        builder.init();
    }
}
