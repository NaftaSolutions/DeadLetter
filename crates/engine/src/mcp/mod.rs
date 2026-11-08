//! Embedded MCP (Model Context Protocol) server: lets an AI agent the user has explicitly
//! enabled browse the workspace and run saved requests. Everything here is opt-in; nothing
//! is started unless the user turns the server on.
//!
//! * `protocol` - transport-agnostic JSON-RPC handling (`initialize`, `tools/list`, `tools/call`)
//! * `tools`    - the tools an agent can call
//! * `redact`   - keeps secret environment values and oversized bodies out of tool output

// Wired up by the server transport in a later change.
#![allow(dead_code)]

mod protocol;
mod redact;
mod tools;

pub(crate) use protocol::Handler;
pub(crate) use tools::{Approver, Context};
