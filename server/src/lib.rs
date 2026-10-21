//! Kalzit server: a self-hosted platform for visualizing and analyzing data.

pub mod app;
pub mod audit;
pub mod auth;
pub mod authz;
pub mod clock;
pub mod config;
pub mod datasources;
pub mod db;
pub mod error;
pub mod extract;
pub mod http;
pub mod net;
pub mod routes;
pub mod secrets;
pub mod server;
pub mod settings;
pub mod shapes;
pub mod tls;
pub mod web;
