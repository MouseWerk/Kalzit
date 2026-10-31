//! What the SCIM endpoints offer (RFC 7643, sections 5 to 7): the service provider configuration,
//! the resource types and the schemas of the attributes Kalzit keeps.

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};

use super::{Ctx, MAX_RESULTS, ScimError, ScimResult, list_response, scim_json};

pub const USER_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:User";
pub const GROUP_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:Group";
const CONFIG_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const RESOURCE_TYPE_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCHEMA_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:Schema";

pub fn service_provider_config(ctx: &Ctx<'_>) -> Response {
    let body = json!({
        "schemas": [CONFIG_SCHEMA],
        "documentationUri": "https://github.com/MouseWerk/Kalzit/blob/main/docs/api/scim.md",
        "patch": { "supported": true },
        "bulk": { "supported": false, "maxOperations": 0, "maxPayloadSize": 0 },
        "filter": { "supported": true, "maxResults": MAX_RESULTS },
        "changePassword": { "supported": false },
        "sort": { "supported": false },
        "etag": { "supported": false },
        "authenticationSchemes": [{
            "type": "oauthbearertoken",
            "name": "SCIM token",
            "description": "The organization's SCIM token (kz_scim_...) as a bearer token",
            "primary": true,
        }],
        "meta": { "resourceType": "ServiceProviderConfig", "location": format!("{}/ServiceProviderConfig", ctx.base) },
    });
    scim_json(StatusCode::OK, &body)
}

fn resource_type_of(ctx: &Ctx<'_>, name: &str) -> Option<Value> {
    let (endpoint, schema, description) = match name {
        "User" => ("/Users", USER_SCHEMA, "People of the organization"),
        "Group" => ("/Groups", GROUP_SCHEMA, "Groups of the organization's directory"),
        _ => return None,
    };
    Some(json!({
        "schemas": [RESOURCE_TYPE_SCHEMA],
        "id": name,
        "name": name,
        "endpoint": endpoint,
        "description": description,
        "schema": schema,
        "meta": { "resourceType": "ResourceType", "location": format!("{}/ResourceTypes/{name}", ctx.base) },
    }))
}

pub fn resource_types(ctx: &Ctx<'_>) -> Response {
    let all: Vec<Value> = ["User", "Group"].iter().filter_map(|n| resource_type_of(ctx, n)).collect();
    let paging = super::Paging { start_index: 1, count: all.len() as i64 };
    list_response(all.len() as i64, &paging, all)
}

pub fn resource_type(ctx: &Ctx<'_>, name: &str) -> ScimResult<Response> {
    resource_type_of(ctx, name).map(|v| scim_json(StatusCode::OK, &v)).ok_or_else(ScimError::not_found)
}

/// An attribute definition; `sub` are the sub-attributes of a complex one.
fn attr(name: &str, kind: &str, multi: bool, required: bool, mutability: &str, sub: &[Value]) -> Value {
    let mut a = json!({
        "name": name,
        "type": kind,
        "multiValued": multi,
        "required": required,
        "caseExact": false,
        "mutability": mutability,
        "returned": "default",
        "uniqueness": "none",
    });
    if !sub.is_empty() {
        a["subAttributes"] = json!(sub);
    }
    a
}

fn schema_of(ctx: &Ctx<'_>, id: &str) -> Option<Value> {
    let rw = "readWrite";
    let (name, attributes) = match id {
        USER_SCHEMA => {
            let mut user_name = attr("userName", "string", false, true, rw, &[]);
            user_name["uniqueness"] = json!("server");
            let name = attr(
                "name",
                "complex",
                false,
                false,
                rw,
                &[
                    attr("formatted", "string", false, false, rw, &[]),
                    attr("familyName", "string", false, false, rw, &[]),
                    attr("givenName", "string", false, false, rw, &[]),
                    attr("middleName", "string", false, false, rw, &[]),
                ],
            );
            let emails = attr(
                "emails",
                "complex",
                true,
                false,
                rw,
                &[
                    attr("value", "string", false, false, rw, &[]),
                    attr("type", "string", false, false, rw, &[]),
                    attr("primary", "boolean", false, false, rw, &[]),
                ],
            );
            let groups = attr(
                "groups",
                "complex",
                true,
                false,
                "readOnly",
                &[
                    attr("value", "string", false, false, "readOnly", &[]),
                    attr("display", "string", false, false, "readOnly", &[]),
                ],
            );
            let attributes = vec![
                user_name,
                name,
                attr("displayName", "string", false, false, rw, &[]),
                emails,
                attr("active", "boolean", false, false, rw, &[]),
                groups,
            ];
            ("User", attributes)
        }
        GROUP_SCHEMA => {
            let members = attr(
                "members",
                "complex",
                true,
                false,
                rw,
                &[
                    attr("value", "string", false, false, "immutable", &[]),
                    attr("display", "string", false, false, "readOnly", &[]),
                ],
            );
            ("Group", vec![attr("displayName", "string", false, true, rw, &[]), members])
        }
        _ => return None,
    };
    Some(json!({
        "schemas": [SCHEMA_SCHEMA],
        "id": id,
        "name": name,
        "attributes": attributes,
        "meta": { "resourceType": "Schema", "location": format!("{}/Schemas/{id}", ctx.base) },
    }))
}

pub fn schemas(ctx: &Ctx<'_>) -> Response {
    let all: Vec<Value> = [USER_SCHEMA, GROUP_SCHEMA].iter().filter_map(|id| schema_of(ctx, id)).collect();
    let paging = super::Paging { start_index: 1, count: all.len() as i64 };
    list_response(all.len() as i64, &paging, all)
}

pub fn schema(ctx: &Ctx<'_>, id: &str) -> ScimResult<Response> {
    schema_of(ctx, id).map(|v| scim_json(StatusCode::OK, &v)).ok_or_else(ScimError::not_found)
}
