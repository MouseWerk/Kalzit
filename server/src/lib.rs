//! Kalzit server: a self-hosted platform for visualizing and analyzing data.

// The build script's date and commit checks, tested here (build scripts have no tests of their own).
#[cfg(test)]
#[path = "../build_info.rs"]
mod build_info;

pub mod acme;
pub mod ai;
pub mod analysis;
pub mod app;
pub mod appearance;
pub mod audit;
pub mod auth;
pub mod authz;
pub mod clock;
pub mod cluster;
pub mod config;
pub mod dashboards;
pub mod data_dir;
pub mod datasources;
pub mod db;
pub mod error;
pub mod extract;
pub mod folders;
pub mod http;
pub mod http_limits;
pub mod live;
pub mod locks;
pub mod mail;
pub mod net;
pub mod plugins;
pub mod routes;
pub mod saved_analyses;
pub mod secrets;
pub mod server;
pub mod service;
pub mod settings;
pub mod shapes;
pub mod sso;
pub mod text;
pub mod tls;
pub mod updates;
pub mod usage;
pub mod web;
