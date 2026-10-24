use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use kalzit::config::{Config, LogConfig};
use kalzit::server::Outcome;
use kalzit::updates::boot::{self, Boot};
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
    /// Install updates from the command line (where the server does not install on its own).
    Update {
        #[command(subcommand)]
        action: UpdateCommand,
    },
}

#[derive(Subcommand)]
enum SecretsCommand {
    /// Re-encrypt every stored secret with a new key. Stop the server first.
    Rotate,
}

#[derive(Subcommand)]
enum UpdateCommand {
    /// Show the installed version, the release ready to install and the kept versions.
    Status,
    /// Install the downloaded or uploaded release. Stop the server first, start it afterwards.
    Apply {
        /// PostgreSQL: you backed the database up yourself (Kalzit cannot).
        #[arg(long)]
        acknowledge_no_backup: bool,
    },
    /// Return to a kept version. Stop the server first, start it afterwards.
    Rollback {
        version: String,
        /// Put back the database backup taken when that version was left (needed when the
        /// database changed since; what changed since is lost).
        #[arg(long)]
        restore_database: bool,
    },
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
            for warning in &config.warnings {
                eprintln!("kalzit: warning: {warning}");
            }
            println!("configuration is valid; data directory {}", config.paths.data_dir.display());
            ExitCode::SUCCESS
        }
        Command::Secrets { action: SecretsCommand::Rotate } => {
            init_logging(&config.log);
            let Some(runtime) = runtime() else { return ExitCode::FAILURE };
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
        Command::Update { action } => {
            init_logging(&config.log);
            let Some(runtime) = runtime() else { return ExitCode::FAILURE };
            let result = match action {
                UpdateCommand::Status => Ok(kalzit::updates::cli::status(&config)),
                UpdateCommand::Apply { acknowledge_no_backup } => {
                    runtime.block_on(kalzit::updates::cli::apply(&config, acknowledge_no_backup))
                }
                UpdateCommand::Rollback { version, restore_database } => {
                    runtime.block_on(kalzit::updates::cli::rollback(&config, &version, restore_database))
                }
            };
            match result {
                Ok(text) => {
                    println!("{}", text.trim_end());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("kalzit: {e:#}");
                    ExitCode::FAILURE
                }
            }
        }
        Command::Serve => {
            init_logging(&config.log);
            // An update in progress decides first, before anything opens the database: the
            // first start of a new version runs as a trial, a failed one returns.
            let trial = match boot::guard(&config) {
                Boot::Run(trial) => trial,
                Boot::Relaunch(exe) => return kalzit::updates::platform::relaunch(&exe),
            };
            let Some(runtime) = runtime() else { return ExitCode::FAILURE };
            let outcome = runtime.block_on(kalzit::server::run(config, trial));
            // Every task and with it every handle on the data directory ends here, before another
            // binary starts on it.
            runtime.shutdown_timeout(Duration::from_secs(5));
            match outcome {
                Ok(Outcome::Stopped) => ExitCode::SUCCESS,
                Ok(Outcome::Handover(handover)) => boot::handover(&handover),
                Err(e) => {
                    tracing::error!("{e:#}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

fn runtime() -> Option<tokio::runtime::Runtime> {
    match tokio::runtime::Runtime::new() {
        Ok(r) => Some(r),
        Err(e) => {
            eprintln!("kalzit: cannot start the async runtime: {e}");
            None
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
