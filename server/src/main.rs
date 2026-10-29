use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use kalzit::config::{Config, LogConfig};
use kalzit::server::Outcome;
use kalzit::service::ServiceOptions;
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
    /// Ask the running server on this machine whether it is ready (exit code 0), for container
    /// health checks. Uses the plain HTTP listener.
    Healthcheck,
    /// Print the one-time setup code of the first start from the data directory.
    SetupCode,
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
    /// Run Kalzit as a Windows service (account NT SERVICE\Kalzit). Install, uninstall and the
    /// steps of the MSI package need an elevated prompt.
    Service {
        #[command(subcommand)]
        action: ServiceCommand,
    },
    /// Start a test program in the plugin sandbox and list the protections in force (Linux).
    /// Run it as the service account, or inside the service, to see what plugins get there.
    SandboxCheck,
    /// The test program of `sandbox-check`: prints its own capability sets.
    #[command(hide = true)]
    SandboxProbe,
}

#[derive(Subcommand)]
enum ServiceCommand {
    /// Create the service "Kalzit" for this program, write the configuration (unless it exists),
    /// secure the data folder and start the service.
    Install {
        #[command(flatten)]
        options: ServiceOptions,
        /// Set everything up, but do not start the service.
        #[arg(long)]
        no_start: bool,
    },
    /// Stop and remove the service and its firewall rule. The data and the configuration stay.
    Uninstall {
        /// Also remove the data folder and the configuration file.
        #[arg(long)]
        remove_data: bool,
    },
    /// Run as the service; the Windows service manager starts this.
    Run,
    /// The MSI package's setup step for a service it created (configuration, data folder,
    /// recovery, firewall).
    #[command(hide = true)]
    Configure {
        #[command(flatten)]
        options: ServiceOptions,
        /// The installed program (the MSI runs this step from its own copy of kalzit.exe).
        #[arg(long, value_name = "FILE")]
        program: Option<String>,
    },
    /// The MSI package's step before it removes the program (firewall rule, data on request).
    #[command(hide = true)]
    Cleanup {
        #[arg(long, value_name = "1|0", default_value = "0")]
        remove_data: String,
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
    // Windows: DLLs loaded at run time come from System32 only, never from the program folder.
    #[cfg(windows)]
    kalzit::service::restrict_dll_search();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cli = Cli::parse();
    // Runs inside the sandbox, where no configuration is readable.
    if matches!(cli.command, Some(Command::SandboxProbe)) {
        println!("{}", kalzit::plugins::sandbox::probe());
        return ExitCode::SUCCESS;
    }
    let command = match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => return serve(cli.config.as_deref(), Logging::Console),
        Command::Service { action } => return service(action, cli.config),
        other => other,
    };
    let config = match Config::load(cli.config.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("kalzit: configuration error: {e:#}");
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Serve | Command::Service { .. } => unreachable!("handled above"),
        Command::CheckConfig => {
            for warning in &config.warnings {
                eprintln!("kalzit: warning: {warning}");
            }
            println!("configuration is valid; data directory {}", config.paths.data_dir.display());
            ExitCode::SUCCESS
        }
        Command::Healthcheck => {
            let Some(addr) = config.http_addr() else {
                eprintln!("kalzit: no plain HTTP listener (server.http_addr) to check");
                return ExitCode::FAILURE;
            };
            match kalzit::routes::health::probe(addr, Duration::from_secs(5)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("kalzit: not ready: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Command::SetupCode => match kalzit::routes::setup::read_code(&config.paths.data_dir) {
            Ok(Some(code)) => {
                println!("{code}");
                ExitCode::SUCCESS
            }
            Ok(None) => {
                eprintln!(
                    "kalzit: no setup code in {}: setup is complete, the server has not started yet, or \
                     KALZIT_SETUP_TOKEN sets the code",
                    config.paths.data_dir.display()
                );
                ExitCode::FAILURE
            }
            Err(e) => {
                eprintln!("kalzit: reading the setup code: {e}");
                ExitCode::FAILURE
            }
        },
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
        Command::SandboxProbe => unreachable!("handled before the configuration loads"),
        Command::SandboxCheck => {
            let Some(runtime) = runtime() else { return ExitCode::FAILURE };
            match runtime.block_on(kalzit::plugins::sandbox::check()) {
                Ok(report) => {
                    println!("{report}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("kalzit: {e:#}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

/// Where `serve` logs: the console, or as the Windows service a file in the data directory
/// (with the Windows event log for what happens before that file is open).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Logging {
    Console,
    #[cfg(windows)]
    Service,
}

impl Logging {
    /// An error that ends the start; tracing may not be set up yet.
    fn fatal(self, message: &str) {
        match self {
            Logging::Console => eprintln!("kalzit: {message}"),
            #[cfg(windows)]
            Logging::Service => {
                tracing::error!("{message}");
                kalzit::service::event_log_error(message);
            }
        }
    }

    fn init(self, cfg: &LogConfig, data_dir: &Path) {
        match self {
            Logging::Console => init_logging(cfg),
            #[cfg(windows)]
            Logging::Service => match kalzit::service::LogFile::open(data_dir) {
                Ok(file) => init_logging_to(cfg, move || file.clone()),
                Err(e) => {
                    kalzit::service::event_log_error(&format!(
                        "Kalzit cannot write its log in {}: {e:#}",
                        data_dir.display()
                    ));
                    init_logging_to(cfg, std::io::sink);
                }
            },
        }
        #[cfg(not(windows))]
        let _ = data_dir;
    }
}

/// `kalzit serve`, and the Windows service's run.
fn serve(config_path: Option<&Path>, logging: Logging) -> ExitCode {
    let config = match Config::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            logging.fatal(&format!("configuration error: {e:#}"));
            // The first start of a new version that refuses the configuration returns to the
            // previous version, which accepted it.
            if let Some(data_dir) = Config::data_dir_hint(config_path) {
                // The configured logging did not load; the return is reported with the defaults.
                logging.init(&LogConfig::default(), &data_dir);
                if let Some(exe) = boot::after_config_error(&data_dir, &format!("{e:#}")) {
                    logging.fatal(&format!(
                        "this version refused the configuration after an update; returning to the previous version \
                         ({})",
                        exe.display()
                    ));
                    return kalzit::updates::platform::relaunch(&exe);
                }
            }
            return ExitCode::from(2);
        }
    };
    logging.init(&config.log, &config.paths.data_dir);
    for warning in &config.warnings {
        tracing::warn!("{warning}");
    }
    // An update in progress decides first, before anything opens the database: the first start
    // of a new version runs as a trial, a failed one returns.
    let trial = match boot::guard(&config) {
        Boot::Run(trial) => trial,
        Boot::Relaunch(exe) => return kalzit::updates::platform::relaunch(&exe),
    };
    let Some(runtime) = runtime() else { return ExitCode::FAILURE };
    let outcome = runtime.block_on(kalzit::server::run(config, trial));
    // Every task and with it every handle on the data directory ends here, before another binary
    // starts on it.
    runtime.shutdown_timeout(Duration::from_secs(5));
    match outcome {
        Ok(Outcome::Stopped) => ExitCode::SUCCESS,
        Ok(Outcome::Handover(handover)) => boot::handover(&handover),
        Err(e) => {
            logging.fatal(&format!("{e:#}"));
            ExitCode::FAILURE
        }
    }
}

/// The configuration file `kalzit service ...` uses: `--config`, else
/// `%ProgramData%\Kalzit\kalzit.toml`.
#[cfg(windows)]
fn service_config(config: Option<PathBuf>) -> Option<PathBuf> {
    let path = config.or_else(|| kalzit::config::program_data_folder().map(|f| f.join("kalzit.toml")))?;
    std::path::absolute(path).ok()
}

#[cfg(windows)]
static SERVICE_CONFIG: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

#[cfg(windows)]
fn serve_as_service() -> ExitCode {
    serve(SERVICE_CONFIG.get().cloned().flatten().as_deref(), Logging::Service)
}

#[cfg(windows)]
fn service(action: ServiceCommand, config: Option<PathBuf>) -> ExitCode {
    use kalzit::service;
    if let ServiceCommand::Run = action {
        let _ = SERVICE_CONFIG.set(config);
        return service::run(serve_as_service);
    }
    let Some(config) = service_config(config) else {
        eprintln!("kalzit: the ProgramData environment variable is not set; pass --config");
        return ExitCode::FAILURE;
    };
    let default_data_dir = kalzit::config::default_data_dir();
    // The installer's steps have no console: their errors go to the event log as well.
    let (result, quiet) = match action {
        ServiceCommand::Run => unreachable!("handled above"),
        ServiceCommand::Install { options, no_start } => {
            (options.settings(config, default_data_dir).and_then(|s| service::install(&s, !no_start)), false)
        }
        ServiceCommand::Uninstall { remove_data } => (service::uninstall(&config, remove_data), false),
        ServiceCommand::Configure { options, program } => {
            let result = options.settings(config, default_data_dir).and_then(|s| {
                let exe = match program.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                    Some(p) if p.contains('"') => anyhow::bail!("--program must not contain a quote"),
                    Some(p) => PathBuf::from(p),
                    None => std::env::current_exe()?,
                };
                service::configure(&s, &exe).map(|lines| lines.join("\n"))
            });
            (result, true)
        }
        ServiceCommand::Cleanup { remove_data } => {
            let remove = matches!(remove_data.trim(), "1" | "yes" | "true");
            (service::cleanup(&config, remove).map(|lines| lines.join("\n")), true)
        }
    };
    match result {
        Ok(text) => {
            println!("{}", text.trim_end());
            ExitCode::SUCCESS
        }
        Err(e) => {
            if quiet {
                service::event_log_error(&format!("Kalzit installer step failed: {e:#}"));
            }
            eprintln!("kalzit: {e:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn service(_action: ServiceCommand, _config: Option<PathBuf>) -> ExitCode {
    eprintln!(
        "kalzit: `kalzit service` sets up the Windows service; on Linux, run Kalzit under systemd \
         (docs/ARCHITECTURE.md, \"Running as a service\")"
    );
    ExitCode::FAILURE
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

/// Logging into `writer` (the service's log file), without terminal colors.
#[cfg(windows)]
fn init_logging_to<W>(cfg: &LogConfig, writer: W)
where
    W: for<'a> tracing_subscriber::fmt::MakeWriter<'a> + Send + Sync + 'static,
{
    let filter = EnvFilter::try_new(&cfg.level).expect("log.level is checked in Config::validate");
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).with_writer(writer);
    if cfg.format == "json" {
        builder.json().init();
    } else {
        builder.init();
    }
}
