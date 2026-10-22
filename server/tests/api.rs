use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use mindsync_server::{Config, app};
use serde_json::{Value, json};
use tower::ServiceExt;

const ADMIN: &str = "integration-test-admin-credential-at-least-32-characters";
static DATABASE_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn library_name_is_display_metadata_and_preserves_vault_identity() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"unchanged").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("name-op", "name-file", "note.md", 0, &hash, 9),
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, before) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(before["library_name"], "Test library");
    let name = "\u{7b14}\u{8bb0} <script>literal</script>";
    let renamed = app(Config {
        library_name: name.into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    let (_, after) = request(&renamed, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(after["library_name"], name);
    for key in ["vault_id", "cursor", "protocol"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(
        std::fs::read(dir.path().join("vault/note.md")).unwrap(),
        b"unchanged"
    );
    let unnamed = app(Config {
        library_name: "   ".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        request(&unnamed, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["library_name"],
        "MindSync"
    );
}

#[tokio::test]
async fn admin_session_rotation_preserves_devices_and_library() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"Recovery fixture"}),
    )
    .await;
    let hash = upload(&router, ADMIN, b"keep notes").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("recovery-op", "recovery-file", "notes.md", 0, &hash, 10),
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, before) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    let replacement = "replacement-admin-credential-at-least-32-characters";
    let restarted = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: replacement.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    let pool = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&pool)
        .await
        .unwrap();
    seed_admin_session(&pool, replacement).await;
    pool.close().await;
    assert_eq!(
        request(&restarted, "GET", "/v1/devices", ADMIN, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, devices) =
        request(&restarted, "GET", "/v1/devices", replacement, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(devices["devices"][0]["id"], device["id"]);
    let device_token = device["token"].as_str().unwrap();
    let (status, after) = request(&restarted, "GET", "/v1/info", device_token, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["vault_id"], before["vault_id"]);
    assert_eq!(after["cursor"], before["cursor"]);
    assert_eq!(
        request(&restarted, "GET", "/v1/devices", device_token, Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/notes.md")).unwrap(),
        b"keep notes"
    );
}

#[tokio::test]
async fn configuration_scope_isolated_and_restart_safe() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"{}").await;
    let (_, info) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(info["configuration_sync"], true);
    assert_eq!(info["configuration_groups"], true);
    let note = put("note-op", "note-id", "app.json", 0, &hash, 2);
    assert_eq!(
        operation(&router, ADMIN, note.clone()).await.0,
        StatusCode::OK
    );
    let configuration = put("config-op", "config-id", "app.json", 0, &hash, 2);
    let (status, committed) = request(
        &router,
        "POST",
        "/v1/configuration/operations",
        ADMIN,
        configuration.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert_eq!(committed["file"]["scope"], "configuration");
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            configuration
        )
        .await
        .1,
        committed
    );
    assert_eq!(
        operation(&router, ADMIN, note).await.1["file"]["revision"],
        1
    );
    for (prefix, id) in [("/v1", "note-id"), ("/v1/configuration", "config-id")] {
        let (_, snapshot) = request(
            &router,
            "GET",
            &format!("{prefix}/snapshot"),
            ADMIN,
            Value::Null,
        )
        .await;
        assert_eq!(snapshot["files"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["files"][0]["id"], id);
        let (_, changes) = request(
            &router,
            "GET",
            &format!("{prefix}/changes?after=0"),
            ADMIN,
            Value::Null,
        )
        .await;
        assert_eq!(changes["changes"].as_array().unwrap().len(), 1);
        assert_eq!(changes["changes"][0]["id"], id);
    }
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/configuration/changes?after=2",
            ADMIN,
            Value::Null
        )
        .await
        .1["cursor"],
        2
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/files/config-id/history",
            ADMIN,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/config-op",
            ADMIN,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/configuration/operations/note-op",
            ADMIN,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("cross-op", "config-id", "app.json", 2, &hash, 2)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            put("note-op", "another", "hotkeys.json", 0, &hash, 2)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/app.json")).unwrap(),
        b"{}"
    );
    assert_eq!(
        std::fs::read(dir.path().join("configuration/app.json")).unwrap(),
        b"{}"
    );
    let rename = json!({"operation_id":"config-rename","kind":"rename","file_id":"config-id","path":"hotkeys.json","base_revision":2});
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            rename
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(dir.path().join("vault/app.json").is_file());
    assert!(!dir.path().join("configuration/app.json").exists());
    let restart = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("configuration/hotkeys.json")).unwrap(),
        b"{}"
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/app.json")).unwrap(),
        b"{}"
    );
    let (_, history) = request(
        &restart,
        "GET",
        "/v1/configuration/files/config-id/history",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(history["versions"].as_array().unwrap().len(), 2);
    let delete = json!({"operation_id":"config-delete","kind":"delete","file_id":"config-id","base_revision":3});
    assert_eq!(
        request(
            &restart,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            delete
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(!dir.path().join("configuration/hotkeys.json").exists());
    assert!(dir.path().join("vault/app.json").is_file());
}

#[tokio::test]
async fn configuration_scope_rejects_private_and_invalid_paths() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, _dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"{}").await;
    for (index, path) in [
        "workspace.json",
        "workspace-mobile.json",
        "plugins/mindsync/data.json",
        "plugins/obsidian-livesync/data.json",
        "../app.json",
        "plugins/calendar/cache.json",
        "themes/.hidden/theme.css",
        "plugins/calendar/../main.js",
    ]
    .iter()
    .enumerate()
    {
        let (status, body) = request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            put(
                &format!("blocked-{index}"),
                &format!("id-{index}"),
                path,
                0,
                &hash,
                2,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {body}");
    }
    for (index, path) in [
        "appearance.json",
        "snippets/custom.css",
        "themes/Example/theme.css",
        "plugins/calendar/main.js",
        "plugins/calendar/data.json",
        "community-plugins.json",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            request(
                &router,
                "POST",
                "/v1/configuration/operations",
                ADMIN,
                put(
                    &format!("allowed-{index}"),
                    &format!("allowed-id-{index}"),
                    path,
                    0,
                    &hash,
                    2
                )
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/configuration/snapshot",
            "invalid",
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&router, "GET", "/v1/snapshot", ADMIN, Value::Null)
            .await
            .1["files"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}
#[tokio::test]
async fn configuration_packages_validate_and_preserve_descriptors() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, _dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"{}").await;
    let members = ["plugins/example/main.js", "plugins/example/manifest.json"];
    let descriptor = json!({"id":"package-one","members":members});
    for (index, path) in members.iter().enumerate() {
        let mut body = put(
            &format!("package-op-{index}"),
            &format!("package-file-{index}"),
            path,
            0,
            &hash,
            2,
        );
        body["group"] = descriptor.clone();
        let (status, result) = request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["file"]["group"], descriptor);
        assert_eq!(
            request(&router, "POST", "/v1/configuration/operations", ADMIN, body)
                .await
                .1,
            result
        );
    }
    let (_, snapshot) = request(
        &router,
        "GET",
        "/v1/configuration/snapshot",
        ADMIN,
        Value::Null,
    )
    .await;
    for record in snapshot["files"].as_array().unwrap() {
        assert_eq!(record["group"], descriptor);
    }
    for (index, group) in [
        json!({"id":"bad/identity","members":["app.json"]}),
        json!({"id":"duplicate","members":["app.json","app.json"]}),
        json!({"id":"missing","members":["hotkeys.json"]}),
        json!({"id":"cross-group","members":["app.json","hotkeys.json"]}),
        json!({"id":"private","members":["app.json","plugins/mindsync/data.json"]}),
    ]
    .into_iter()
    .enumerate()
    {
        let mut body = put(
            &format!("invalid-package-{index}"),
            &format!("invalid-file-{index}"),
            "app.json",
            0,
            &hash,
            2,
        );
        body["group"] = group;
        let (status, result) =
            request(&router, "POST", "/v1/configuration/operations", ADMIN, body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{result}");
    }
    let mut note = put(
        "note-package-op",
        "note-package-file",
        "app.json",
        0,
        &hash,
        2,
    );
    note["group"] = json!({"id":"note-package","members":["app.json"]});
    assert_eq!(
        operation(&router, ADMIN, note).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let deletion = json!({"operation_id":"delete-package","kind":"delete","file_id":"package-file-0","base_revision":1,"group":descriptor});
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            deletion
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

async fn request(
    router: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn fixture() -> (Router, tempfile::TempDir) {
    fixture_with_limit(1024).await
}
async fn fixture_with_limit(limit: usize) -> (Router, tempfile::TempDir) {
    let db = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
    let pool = sqlx::PgPool::connect(&db).await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let dir = tempfile::tempdir().unwrap();
    let router = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: db,
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: limit,
    })
    .await
    .unwrap();
    let pool = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    seed_admin_session(&pool, ADMIN).await;
    pool.close().await;
    (router, dir)
}
async fn seed_admin_session(pool: &sqlx::PgPool, token: &str) {
    use sha2::{Digest, Sha256};
    sqlx::query("INSERT INTO auth_owner(singleton,id,email,password_hash) VALUES(TRUE,'fixture-owner','owner@example.com','unused-fixture-hash') ON CONFLICT DO NOTHING").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,csrf_hash,created_at,last_seen,expires_at) VALUES($1,'fixture-owner','fixture',EXTRACT(EPOCH FROM NOW())::bigint,EXTRACT(EPOCH FROM NOW())::bigint,EXTRACT(EPOCH FROM NOW())::bigint+43200) ON CONFLICT DO NOTHING")
        .bind(hex::encode(Sha256::digest(token.as_bytes()))).execute(pool).await.unwrap();
}
#[tokio::test]
async fn postgres_api_integration() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, _dir) = fixture().await;
    let (status, info) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["cursor"], 0);
}

async fn upload(router: &Router, token: &str, bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(bytes));
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/v1/objects/{hash}"))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(bytes.to_vec()))
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    hash
}
fn put(op: &str, id: &str, path: &str, rev: i64, hash: &str, size: usize) -> Value {
    json!({"operation_id":op,"kind":"put","file_id":id,"path":path,"base_revision":rev,"hash":hash,"size":size})
}
async fn operation(router: &Router, token: &str, data: Value) -> (StatusCode, Value) {
    request(router, "POST", "/v1/operations", token, data).await
}
#[tokio::test]
async fn fault_and_conflict_contract() {
    let _serial = DATABASE_TEST.lock().await;
    // Run serially: this suite intentionally resets one disposable test database.
    let (router, dir) = fixture().await;
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"phone"}),
    )
    .await;
    let token = device["token"].as_str().unwrap();
    let hash = upload(&router, token, b"one").await;
    let create = put("create", "note", "Folder/note.md", 0, &hash, 3);
    let (status, result) = operation(&router, token, create.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["cursor"], 1);
    assert_eq!(
        std::fs::read(dir.path().join("vault/Folder/note.md")).unwrap(),
        b"one"
    );
    assert_eq!(operation(&router, token, create.clone()).await.1, result);
    assert_eq!(
        request(&router, "GET", "/v1/operations/create", token, Value::Null)
            .await
            .1,
        result
    );
    assert_eq!(
        operation(&router, ADMIN, create).await.1["error"]["code"],
        "OPERATION_REUSED"
    );
    assert_eq!(
        request(&router, "GET", "/v1/operations/create", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "OPERATION_REUSED"
    );
    let hash2 = upload(&router, token, b"two").await;
    let a = operation(
        &router,
        token,
        put("writer-a", "note", "Folder/note.md", 1, &hash2, 3),
    );
    let b = operation(
        &router,
        token,
        put("writer-b", "note", "Folder/note.md", 1, &hash, 3),
    );
    let (a, b) = tokio::join!(a, b);
    assert_eq!(
        [a.0, b.0].iter().filter(|&&s| s == StatusCode::OK).count(),
        1
    );
    let stale_delete =
        json!({"operation_id":"stale-delete","kind":"delete","file_id":"note","base_revision":1});
    assert_eq!(
        operation(&router, token, stale_delete).await.1["error"]["code"],
        "REVISION_CONFLICT"
    );
    for (n, path) in [
        "folder/other.md",
        "FOLDER/note.md",
        "Folder",
        "Folder/note.md/child",
        "../escape",
        "/absolute",
        "CON.md",
        "a\\b",
        "x/..",
        "x/aux.txt",
        "bad?.md",
        ".obsidian/x",
        "trail. ",
    ]
    .iter()
    .enumerate()
    {
        let (status, result) = operation(
            &router,
            token,
            put(
                &format!("invalid{n}"),
                &format!("bad{n}"),
                path,
                0,
                &hash,
                3,
            ),
        )
        .await;
        assert!(
            status == StatusCode::CONFLICT || status == StatusCode::UNPROCESSABLE_ENTITY,
            "{path}: {result}"
        );
    }
    let (_, info) = request(&router, "GET", "/v1/info", token, Value::Null).await;
    assert_eq!(info["cursor"], 2);
    let (_, page) = request(
        &router,
        "GET",
        "/v1/changes?after=0&limit=1",
        token,
        Value::Null,
    )
    .await;
    assert_eq!(page["until"], 2);
    assert_eq!(page["cursor"], 1);
    assert_eq!(page["has_more"], true);
    let (_, deleted) = operation(
        &router,
        token,
        json!({"operation_id":"delete","kind":"delete","file_id":"note","base_revision":2}),
    )
    .await;
    assert_eq!(deleted["file"]["deleted"], true);
    assert_eq!(deleted["cursor"], 3);
    assert!(!dir.path().join("vault/Folder/note.md").exists());
    assert_eq!(
        operation(
            &router,
            token,
            put("bad-resurrect", "note", "Folder/note.md", 0, &hash, 3)
        )
        .await
        .1["error"]["code"],
        "REVISION_CONFLICT"
    );
    let (_, page2) = request(
        &router,
        "GET",
        "/v1/changes?after=1&until=2&limit=1",
        token,
        Value::Null,
    )
    .await;
    assert_eq!(page2["cursor"], 2);
    assert_eq!(page2["has_more"], false);
    let (_, restored) = operation(
        &router,
        token,
        put("restore", "note", "Folder/note.md", 3, &hash, 3),
    )
    .await;
    assert_eq!(restored["cursor"], 4);
    assert_eq!(
        request(&router, "GET", "/v1/files/note/history", token, Value::Null)
            .await
            .1["versions"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(operation(&router,token,json!({"operation_id":"rename","kind":"rename","file_id":"note","path":"Folder/NOTE.md","base_revision":4})).await.0,StatusCode::OK);
    let names = std::fs::read_dir(dir.path().join("vault/Folder"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "NOTE.md"));
    assert!(!names.iter().any(|name| name == "note.md"));
    std::fs::write(dir.path().join("vault/Folder/NOTE.md"), b"external edit").unwrap();
    let repaired = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("vault/Folder/NOTE.md")).unwrap(),
        b"one"
    );
    assert_eq!(
        request(&repaired, "GET", "/health", "", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("vault/unsafe")).unwrap();
    assert_eq!(
        operation(
            &repaired,
            token,
            put("symlink", "symlink", "unsafe/escape.md", 0, &hash, 3)
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert!(!outside.path().join("escape.md").exists());
    std::fs::write(dir.path().join(format!("objects/{hash}")), b"bad").unwrap();
    assert_eq!(
        request(
            &repaired,
            "GET",
            &format!("/v1/objects/{hash}"),
            token,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert!(
        app(Config {
            library_name: "Test library".into(),
            data: dir.path().canonicalize().unwrap(),
            database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
            auth: Default::default(),
            setup_credential: ADMIN.into(),
            max_file_bytes: 1024
        })
        .await
        .is_err()
    );
    assert_eq!(
        request(
            &repaired,
            "POST",
            "/v1/devices",
            token,
            json!({"name":"not allowed"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &repaired,
            "DELETE",
            &format!("/v1/devices/{}", device["id"].as_str().unwrap()),
            ADMIN,
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&repaired, "GET", "/v1/info", token, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn bounded_upload_and_projection_crash_recovery() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    assert_eq!(
        request(&router, "GET", "/v1/info", "", Value::Null).await.1["error"]["code"],
        "UNAUTHORIZED"
    );
    assert_eq!(
        request(&router, "POST", "/v1/operations", ADMIN, json!({}))
            .await
            .1["error"]["code"],
        "INVALID_REQUEST"
    );
    for query in [
        "after=-1",
        "after=0&until=99",
        "after=bad",
        "after=0&limit=0",
    ] {
        assert_eq!(
            request(
                &router,
                "GET",
                &format!("/v1/changes?{query}"),
                ADMIN,
                Value::Null
            )
            .await
            .1["error"]["code"],
            "INVALID_REQUEST"
        );
    }
    let hash = upload(&router, ADMIN, b"history").await;
    for id in ["__proto__", "constructor", "prototype"] {
        assert_eq!(
            operation(
                &router,
                ADMIN,
                put("reserved-id", id, "reserved.md", 0, &hash, 7)
            )
            .await
            .1["error"]["code"],
            "INVALID_REQUEST"
        );
    }
    for (bytes, expected) in [
        (b"wrong".to_vec(), "HASH_MISMATCH"),
        (vec![1u8; 1025], "FILE_TOO_LARGE"),
    ] {
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/objects/{hash}"))
            .header("authorization", format!("Bearer {ADMIN}"))
            .body(Body::from(bytes))
            .unwrap();
        let response = router.clone().oneshot(req).await.unwrap();
        let data: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(data["error"]["code"], expected);
    }
    assert_eq!(
        std::fs::read_dir(dir.path().join("tmp")).unwrap().count(),
        0
    );
    let (_, created) = operation(
        &router,
        ADMIN,
        put("original", "one", "notes/a.md", 0, &hash, 7),
    )
    .await;
    assert_eq!(created["cursor"], 1);
    let req = Request::builder()
        .uri(format!("/v1/objects/{hash}"))
        .header("authorization", format!("Bearer {ADMIN}"))
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"history"
    );
    for (n, path) in ["Straße.md", "caf\u{e9}.md"].iter().enumerate() {
        assert_eq!(
            operation(
                &router,
                ADMIN,
                put(
                    &format!("unicode{n}"),
                    &format!("unicode{n}"),
                    path,
                    0,
                    &hash,
                    7
                )
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    for (n, path) in ["STRASSE.md", "cafe\u{301}.md"].iter().enumerate() {
        assert_eq!(
            operation(
                &router,
                ADMIN,
                put(
                    &format!("collision{n}"),
                    &format!("collision{n}"),
                    path,
                    0,
                    &hash,
                    7
                )
            )
            .await
            .1["error"]["code"],
            "PATH_CONFLICT"
        );
    }
    std::fs::create_dir(dir.path().join("vault/crash.md")).unwrap();
    std::fs::write(
        dir.path().join("vault/crash.md/obstacle"),
        b"external obstacle",
    )
    .unwrap();
    let candidate = put("response-loss", "crash", "crash.md", 0, &hash, 7);
    let (status, result) = operation(&router, ADMIN, candidate.clone()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{result}");
    // The metadata was already committed. This models death between commit and projection.
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/response-loss",
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    std::fs::remove_file(dir.path().join("vault/crash.md/obstacle")).unwrap();
    let (_, result) = request(
        &router,
        "GET",
        "/v1/operations/response-loss",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(result["cursor"], 4);
    assert_eq!(
        std::fs::read(dir.path().join("vault/crash.md")).unwrap(),
        b"history"
    );
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep"), b"outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("vault/foreign")).unwrap();
    let rebuilt = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("vault/crash.md")).unwrap(),
        b"history"
    );
    assert_eq!(
        std::fs::read(outside.path().join("keep")).unwrap(),
        b"outside"
    );
    assert_eq!(operation(&rebuilt, ADMIN, candidate).await.1, result);
    assert_eq!(
        request(&rebuilt, "GET", "/v1/snapshot", ADMIN, Value::Null)
            .await
            .1["cursor"],
        4
    );
    let (_, empty) = request(
        &rebuilt,
        "GET",
        "/v1/changes?after=4&until=4",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(empty["cursor"], 4);
    assert_eq!(empty["has_more"], false);
    let object_path = dir.path().join(format!("objects/{hash}"));
    std::fs::remove_file(&object_path).unwrap();
    std::os::unix::fs::symlink(outside.path().join("keep"), &object_path).unwrap();
    assert_eq!(
        request(
            &rebuilt,
            "GET",
            &format!("/v1/objects/{hash}"),
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(
        operation(
            &rebuilt,
            ADMIN,
            put("bad-object", "bad-object", "bad.md", 0, &hash, 7)
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(
        request(&rebuilt, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "STORAGE_ERROR"
    );
}

#[tokio::test]
async fn replayed_tombstone_preserves_new_file_at_same_path() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let old = upload(&router, ADMIN, b"old").await;
    let new = upload(&router, ADMIN, b"new").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("old-create", "old-id", "reuse.md", 0, &old, 3)
        )
        .await
        .0,
        StatusCode::OK
    );
    let deletion =
        json!({"operation_id":"old-delete","kind":"delete","file_id":"old-id","base_revision":1});
    let result = operation(&router, ADMIN, deletion.clone()).await.1;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("new-create", "new-id", "reuse.md", 0, &new, 3)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(operation(&router, ADMIN, deletion).await.1, result);
    assert_eq!(
        std::fs::read(dir.path().join("vault/reuse.md")).unwrap(),
        b"new"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        3
    );
}

#[tokio::test]
async fn storage_health_rejects_symlinks_and_nonregular_objects() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    assert_eq!(
        request(&router, "POST", "/v1/info", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "INVALID_REQUEST"
    );
    assert_eq!(
        request(&router, "GET", "/v1/objects/%FF", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "INVALID_REQUEST"
    );
    let outside = tempfile::tempdir().unwrap();
    let hash = "0".repeat(64);
    let object =
        std::ffi::CString::new(dir.path().join(format!("objects/{hash}")).to_str().unwrap())
            .unwrap();
    assert_eq!(unsafe { libc::mkfifo(object.as_ptr(), 0o600) }, 0);
    assert_eq!(
        request(
            &router,
            "GET",
            &format!("/v1/objects/{hash}"),
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    std::fs::rename(dir.path().join("tmp"), dir.path().join("original-tmp")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("tmp")).unwrap();
    assert_eq!(
        request(&router, "GET", "/health", "", Value::Null).await.1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn deleted_nested_folder_can_be_reused_as_file() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"replacement").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "nested-create",
                "nested-id",
                "former/deep/note.md",
                0,
                &hash,
                11
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(operation(&router,ADMIN,json!({"operation_id":"nested-delete","kind":"delete","file_id":"nested-id","base_revision":1})).await.0,StatusCode::OK);
    let (status, result) = operation(
        &router,
        ADMIN,
        put("folder-reuse", "replacement-id", "former", 0, &hash, 11),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        std::fs::read(dir.path().join("vault/former")).unwrap(),
        b"replacement"
    );
    assert_eq!(result["cursor"], 3);
}

#[tokio::test]
async fn operation_lookup_repairs_committed_projection() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"recover").await;
    let (_, result) = operation(
        &router,
        ADMIN,
        put("recover-result", "recover-id", "recover.md", 0, &hash, 7),
    )
    .await;
    std::fs::remove_file(dir.path().join("vault/recover.md")).unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/recover-result",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/recover.md")).unwrap(),
        b"recover"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        1
    );
}

#[tokio::test]
async fn operation_lookup_removes_stale_historical_projection_safely() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"current").await;
    let replacement = upload(&router, ADMIN, b"replacement").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("history-create", "history-id", "old.md", 0, &hash, 7)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_,renamed)=operation(&router,ADMIN,json!({"operation_id":"history-rename","kind":"rename","file_id":"history-id","path":"new.md","base_revision":1})).await;
    // Model death after commit but before deleting the former projection.
    std::fs::write(dir.path().join("vault/old.md"), b"stale old projection").unwrap();
    std::fs::remove_file(dir.path().join("vault/new.md")).unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert!(!dir.path().join("vault/old.md").exists());
    assert_eq!(
        std::fs::read(dir.path().join("vault/new.md")).unwrap(),
        b"current"
    );
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "path-replacement",
                "replacement-id",
                "old.md",
                0,
                &replacement,
                11
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md")).unwrap(),
        b"replacement"
    );
    assert_eq!(operation(&router,ADMIN,json!({"operation_id":"replacement-delete","kind":"delete","file_id":"replacement-id","base_revision":3})).await.0,StatusCode::OK);
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "path-descendant",
                "descendant-id",
                "old.md/child.md",
                0,
                &replacement,
                11
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md/child.md")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        5
    );
    assert_eq!(operation(&router,ADMIN,json!({"operation_id":"descendant-delete","kind":"delete","file_id":"descendant-id","base_revision":5})).await.0,StatusCode::OK);
    assert!(dir.path().join("vault/old.md").is_dir());
    let (status, recovered) = request(
        &router,
        "GET",
        "/v1/operations/history-rename",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recovered}");
    assert_eq!(recovered, renamed);
    assert!(!dir.path().join("vault/old.md").exists());
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        6
    );
    std::fs::create_dir_all(dir.path().join("vault/old.md/empty/deeper")).unwrap();
    std::fs::write(
        dir.path().join("vault/old.md/untracked.md"),
        b"preserve descendant",
    )
    .unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md/untracked.md")).unwrap(),
        b"preserve descendant"
    );
    std::fs::remove_file(dir.path().join("vault/old.md/untracked.md")).unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert!(!dir.path().join("vault/old.md").exists());
}

#[tokio::test]
async fn same_identity_descendant_to_ancestor_recovery() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"recover ancestor").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "ancestor-create",
                "ancestor-id",
                "folder/note.md",
                0,
                &hash,
                16
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    let rename = json!({"operation_id":"ancestor-rename","kind":"rename","file_id":"ancestor-id","path":"folder","base_revision":1});
    let (status, result) = operation(&router, ADMIN, rename.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    // Recreate the committed-rename crash window: metadata names the ancestor,
    // but its former descendant remains as the only readable projection.
    std::fs::remove_file(dir.path().join("vault/folder")).unwrap();
    std::fs::create_dir(dir.path().join("vault/folder")).unwrap();
    std::fs::write(dir.path().join("vault/folder/note.md"), b"stale descendant").unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/ancestor-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/folder")).unwrap(),
        b"recover ancestor"
    );
    // A second lookup/replay must accept that former descendant paths cannot
    // exist below the now-current regular file.
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/ancestor-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(operation(&router, ADMIN, rename).await.1, result);
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        2
    );
}

#[tokio::test]
async fn same_identity_ancestor_to_descendant_recovery() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"recover descendant").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "descendant-create",
                "descendant-recovery-id",
                "folder",
                0,
                &hash,
                18
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    let rename = json!({"operation_id":"descendant-rename","kind":"rename","file_id":"descendant-recovery-id","path":"folder/note.md","base_revision":1});
    let (status, result) = operation(&router, ADMIN, rename.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    std::fs::remove_file(dir.path().join("vault/folder/note.md")).unwrap();
    std::fs::remove_dir(dir.path().join("vault/folder")).unwrap();
    std::fs::write(dir.path().join("vault/folder"), b"stale ancestor").unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/descendant-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/folder/note.md")).unwrap(),
        b"recover descendant"
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/descendant-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(operation(&router, ADMIN, rename).await.1, result);
    assert_eq!(
        std::fs::read(dir.path().join("vault/folder/note.md")).unwrap(),
        b"recover descendant"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        2
    );
}

async fn upload_chunk(router: &Router, bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(bytes));
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/v1/chunks/{hash}"))
        .header("authorization", format!("Bearer {ADMIN}"))
        .body(Body::from(bytes.to_vec()))
        .unwrap();
    let reply = router.clone().oneshot(req).await.unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    hash
}
fn chunk_put(op: &str, id: &str, path: &str, rev: i64, bytes: &[u8], chunks: &Value) -> Value {
    use sha2::{Digest, Sha256};
    let mut body = put(
        op,
        id,
        path,
        rev,
        &hex::encode(Sha256::digest(bytes)),
        bytes.len(),
    );
    body["chunked"] = json!(true);
    body["chunks"] = chunks.clone();
    body
}
async fn binary_get(router: &Router, path: &str) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .uri(path)
        .header("authorization", format!("Bearer {ADMIN}"))
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
fn age_objects(dir: &std::path::Path) {
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86400);
    for entry in std::fs::read_dir(dir.join("objects")).unwrap() {
        std::fs::File::open(entry.unwrap().path())
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
    }
}
#[tokio::test]
async fn chunk_manifests_deduplicate_and_rebuild_after_restart() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture_with_limit(20 * 1024 * 1024).await;
    let bytes = (0..2 * 1024 * 1024)
        .map(|i| ((i * 31 + i / 262144) % 251) as u8)
        .collect::<Vec<_>>();
    let mut manifest = Vec::new();
    for part in bytes.chunks(262144) {
        let hash = upload_chunk(&router, part).await;
        manifest.push(json!({"hash":hash,"size":part.len()}));
    }
    let chunks = json!(manifest);
    let (status, result) = operation(
        &router,
        ADMIN,
        chunk_put("chunks-one", "one", "one.bin", 0, &bytes, &chunks),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["file"]["chunks"], chunks);
    let (_, missing) = request(
        &router,
        "POST",
        "/v1/chunks/missing",
        ADMIN,
        json!({"hashes":manifest.iter().map(|c| c["hash"].clone()).collect::<Vec<_>>()}),
    )
    .await;
    assert_eq!(missing["missing"], json!([]));
    let (_, before) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    let (status, result) = operation(
        &router,
        ADMIN,
        chunk_put("chunks-two", "two", "two.bin", 0, &bytes, &chunks),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (_, after) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(before["storage_bytes"], after["storage_bytes"]);
    assert_eq!(after["logical_bytes"], bytes.len() * 2);
    assert_eq!(
        std::fs::read(dir.path().join("vault/two.bin")).unwrap(),
        bytes
    );
    let (status,renamed)=operation(&router,ADMIN,json!({"operation_id":"rename-chunks","kind":"rename","file_id":"one","path":"new.bin","base_revision":1})).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["file"]["chunks"], chunks);
    let (status, deleted) = operation(
        &router,
        ADMIN,
        json!({"operation_id":"delete-chunks","kind":"delete","file_id":"one","base_revision":3}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["file"]["chunks"], chunks);
    let restarted = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 20 * 1024 * 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("vault/two.bin")).unwrap(),
        bytes
    );
    let (_, history) = request(
        &restarted,
        "GET",
        "/v1/files/one/history",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(history["versions"][0]["chunks"], chunks);
    let (status, restored) = operation(
        &restarted,
        ADMIN,
        chunk_put("restore-chunks", "one", "new.bin", 4, &bytes, &chunks),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        std::fs::read(dir.path().join("vault/new.bin")).unwrap(),
        bytes
    );
}
#[tokio::test]
async fn missing_chunks_and_invalid_manifests_roll_back() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let first = upload_chunk(&router, b"first").await;
    use sha2::{Digest, Sha256};
    let second = hex::encode(Sha256::digest(b"second"));
    let chunks = json!([{"hash":first,"size":5},{"hash":second,"size":6}]);
    let body = chunk_put("resume", "note", "note.bin", 0, b"firstsecond", &chunks);
    let (status, missing) = operation(&router, ADMIN, body.clone()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(missing["error"]["code"], "MISSING_CHUNK");
    assert_eq!(missing["error"]["missing"], json!([second]));
    let (_, snapshot) = request(&router, "GET", "/v1/snapshot", ADMIN, Value::Null).await;
    assert_eq!(snapshot["cursor"], 0);
    assert_eq!(snapshot["files"], json!([]));
    let (_, ledger) = request(&router, "GET", "/v1/operations/resume", ADMIN, Value::Null).await;
    assert_eq!(ledger["error"]["code"], "NOT_FOUND");
    let (_, missing) = request(
        &router,
        "POST",
        "/v1/chunks/missing",
        ADMIN,
        json!({"hashes":[first,second,first]}),
    )
    .await;
    assert_eq!(missing["present"], 1);
    assert_eq!(missing["missing"], json!([second]));
    upload_chunk(&router, b"second").await;
    let (status, committed) = operation(&router, ADMIN, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    let (status, replayed) = operation(&router, ADMIN, body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed, committed);
    let mut changed = chunk_put("resume", "note", "note.bin", 0, b"firstsecond", &chunks);
    changed["chunks"][0]["hash"] = json!("0".repeat(64));
    let (status, reused) = operation(&router, ADMIN, changed).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(reused["error"]["code"], "OPERATION_REUSED");
    let absent = "1".repeat(64);
    let mut single = put("missing-single", "single", "single.bin", 0, &absent, 1);
    single["chunked"] = json!(false);
    single["chunks"] = json!([{"hash":absent,"size":1}]);
    let (status, missing_single) = operation(&router, ADMIN, single).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(missing_single["error"]["code"], "MISSING_CHUNK");
    assert_eq!(
        std::fs::read(dir.path().join("vault/note.bin")).unwrap(),
        b"firstsecond"
    );
    for parts in [
        json!([]),
        json!([{"hash":first,"size":0}]),
        json!([{"hash":first,"size":4}]),
    ] {
        let (status, error) = operation(
            &router,
            ADMIN,
            chunk_put("invalid", "other", "other.bin", 0, b"firstsecond", &parts),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"]["code"], "INVALID_MANIFEST");
    }
    let mut wrong = chunk_put(
        "wrong-hash",
        "other",
        "other.bin",
        0,
        b"firstsecond",
        &chunks,
    );
    wrong["hash"] = json!("0".repeat(64));
    let (_, error) = operation(&router, ADMIN, wrong).await;
    assert_eq!(error["error"]["code"], "INVALID_MANIFEST");
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/v1/chunks/{}", "0".repeat(64)))
        .header("authorization", format!("Bearer {ADMIN}"))
        .body(Body::from(vec![0u8; 262145]))
        .unwrap();
    assert_eq!(
        router.clone().oneshot(req).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}
#[tokio::test]
async fn manual_gc_protects_legacy_history_chunks_and_resumed_uploads() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let legacy = upload(&router, ADMIN, b"legacy").await;
    let (_, old) = operation(
        &router,
        ADMIN,
        put("legacy", "old", "legacy.md", 0, &legacy, 6),
    )
    .await;
    let left = upload_chunk(&router, b"left").await;
    let right = upload_chunk(&router, b"right").await;
    let chunks = json!([{"hash":left,"size":4},{"hash":right,"size":5}]);
    let (status, result) = operation(
        &router,
        ADMIN,
        chunk_put("chunked", "new", "new.bin", 0, b"leftright", &chunks),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    operation(
        &router,
        ADMIN,
        json!({"operation_id":"delete-new","kind":"delete","file_id":"new","base_revision":2}),
    )
    .await;
    let orphan = upload_chunk(&router, b"orphan").await;
    let resumed = upload_chunk(&router, b"resumed").await;
    age_objects(dir.path());
    request(
        &router,
        "POST",
        "/v1/chunks/missing",
        ADMIN,
        json!({"hashes":[resumed]}),
    )
    .await;
    let (_, before) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    let (_, preview) = request(&router, "POST", "/v1/maintenance/gc", ADMIN, json!({})).await;
    assert_eq!(preview["dry_run"], true);
    assert_eq!(preview["objects"], 1);
    assert!(dir.path().join("objects").join(&orphan).exists());
    let (_, collected) = request(
        &router,
        "POST",
        "/v1/maintenance/gc",
        ADMIN,
        json!({"dry_run":false}),
    )
    .await;
    assert_eq!(collected["objects"], 1);
    assert!(!dir.path().join("objects").join(&orphan).exists());
    for hash in [&legacy, &left, &right, &resumed] {
        assert!(dir.path().join("objects").join(hash).exists());
    }
    let (_, after) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(after["logical_bytes"], before["logical_bytes"]);
    assert!(after["storage_bytes"].as_u64() < before["storage_bytes"].as_u64());
    let (status, restored) = operation(
        &router,
        ADMIN,
        chunk_put("restore-gc", "new", "new.bin", 3, b"leftright", &chunks),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        std::fs::read(dir.path().join("vault/new.bin")).unwrap(),
        b"leftright"
    );
    assert_eq!(
        binary_get(&router, &format!("/v1/objects/{legacy}"))
            .await
            .1,
        b"legacy"
    );
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"phone"}),
    )
    .await;
    let (status, _) = request(
        &router,
        "POST",
        "/v1/maintenance/gc",
        device["token"].as_str().unwrap(),
        json!({"dry_run":false}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let pool = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM version_chunks WHERE revision=3")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
    let restored = operation(
        &router,
        ADMIN,
        put(
            "old-restore",
            "old",
            "legacy.md",
            old["file"]["revision"].as_i64().unwrap(),
            &legacy,
            6,
        ),
    )
    .await;
    assert_eq!(restored.0, StatusCode::OK);
}

#[tokio::test]
async fn upgrade_from_v1_schema_preserves_history_and_operation_fingerprints() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"v1 content").await;
    let body = put("v1-operation", "v1-file", "old.md", 0, &hash, 10);
    let (status, result) = operation(&router, ADMIN, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    // Reconstruct an actual v1 schema/record/ledger, including the 0001 migration
    // bookkeeping, then let normal startup apply the additive migrations.
    let pool = sqlx::PgPool::connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::raw_sql("DROP TABLE auth_sessions,auth_challenges,auth_limits,auth_owner,auth_settings; DROP TABLE version_chunks; ALTER TABLE files DROP COLUMN chunked; DROP INDEX files_active_paths; ALTER TABLE files DROP COLUMN scope; CREATE UNIQUE INDEX files_active_paths ON files(path_key) WHERE NOT deleted; DROP TABLE maintenance; ALTER TABLE devices DROP COLUMN created_at, DROP COLUMN last_seen_at, DROP COLUMN client_version, DROP COLUMN client_platform; DELETE FROM _sqlx_migrations WHERE version>=2; UPDATE changes SET record=record-'chunked'-'chunks'; UPDATE operations SET result=jsonb_set(result,'{file}',(result->'file')-'chunked'-'chunks')")
        .execute(&pool).await.unwrap();
    let restarted = app(Config {
        library_name: "Test library".into(),
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        auth: Default::default(),
        setup_credential: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    seed_admin_session(&pool, ADMIN).await;
    let (status, replay) = operation(&restarted, ADMIN, body).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["file"]["hash"], hash);
    assert_eq!(replay["cursor"], 1);
    assert_eq!(
        binary_get(&restarted, &format!("/v1/objects/{hash}"))
            .await
            .1,
        b"v1 content"
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md")).unwrap(),
        b"v1 content"
    );
    let (_, history) = request(
        &restarted,
        "GET",
        "/v1/files/v1-file/history",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(history["versions"][0]["hash"], hash);
    let chunked = sqlx::query_scalar::<_, bool>("SELECT chunked FROM files WHERE id='v1-file'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!chunked);
    let (status, restored) = operation(
        &restarted,
        ADMIN,
        put("restore-v1", "v1-file", "old.md", 1, &hash, 10),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
}
#[tokio::test]
async fn gc_does_not_interfere_with_an_upload_in_progress() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let orphan = upload_chunk(&router, b"old orphan").await;
    age_objects(dir.path());
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(b"pending upload"));
    let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
    let (entered, started) = tokio::sync::oneshot::channel::<()>();
    let stream = futures_util::stream::once(async move {
        entered.send(()).unwrap();
        receiver.await.unwrap();
        Ok::<_, std::io::Error>("pending upload")
    });
    let upload = Request::builder()
        .method("PUT")
        .uri(format!("/v1/chunks/{hash}"))
        .header("authorization", format!("Bearer {ADMIN}"))
        .body(Body::from_stream(stream))
        .unwrap();
    let upload = tokio::spawn(router.clone().oneshot(upload));
    started.await.unwrap();
    let (status, result) = request(
        &router,
        "POST",
        "/v1/maintenance/gc",
        ADMIN,
        json!({"dry_run":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(!dir.path().join("objects").join(&orphan).exists());
    sender.send(()).unwrap();
    assert_eq!(upload.await.unwrap().unwrap().status(), StatusCode::OK);
    let (status, result) = request(
        &router,
        "POST",
        "/v1/maintenance/gc",
        ADMIN,
        json!({"dry_run":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["objects"], 0);
    assert_eq!(
        binary_get(&router, &format!("/v1/chunks/{hash}")).await.1,
        b"pending upload"
    );
}

async fn admin_get(router: &Router, path: &str, token: Option<&str>) -> axum::response::Response {
    let mut request = Request::builder().uri(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn administration_shell_is_public_but_contains_no_library_data() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, _dir) = fixture().await;
    for (path, mime, marker) in [
        ("/", "text/html", ">Password</label>"),
        ("/admin", "text/html", "MindSync"),
        ("/admin/", "text/html", "MindSync"),
        ("/admin/app.css", "text/css", "prefers-reduced-motion"),
        ("/admin/app.js", "text/javascript", "resetSession"),
        ("/admin/logo.svg", "image/svg+xml", "<svg"),
    ] {
        let response = admin_get(&router, path, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with(mime)
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["x-frame-options"], "DENY");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.contains(marker));
        assert!(!text.contains(ADMIN));
        if mime == "text/html" {
            assert!(text.contains("id=\"login-form\" method=\"post\""));
            assert!(!text.contains("name=\"admin-token\""));
        }
    }
    assert_eq!(
        admin_get(&router, "/v1/admin/files/missing/content", None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        admin_get(&router, "/admin/unknown", None).await.status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn admin_export_checks_identity_scope_revision_and_immutable_content() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"Browser fixture"}),
    )
    .await;
    let token = device["token"].as_str().unwrap();
    let first = upload(&router, ADMIN, b"first revision").await;
    let path = "notes/\u{7b14}\u{8bb0} #100%.md";
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("admin-first", "admin-file", path, 0, &first, 14)
        )
        .await
        .0,
        StatusCode::OK
    );
    let second = upload(&router, ADMIN, b"updated").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("admin-second", "admin-file", path, 1, &second, 7)
        )
        .await
        .0,
        StatusCode::OK
    );
    let url = "/v1/admin/files/admin-file/content";
    assert_eq!(
        admin_get(&router, url, Some(token)).await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin_get(&router, url, Some("wrong-token")).await.status(),
        StatusCode::UNAUTHORIZED
    );
    for (suffix, expected) in [
        ("", b"updated".as_slice()),
        ("?revision=1", b"first revision".as_slice()),
        ("?revision=2&preview=true", b"updated".as_slice()),
    ] {
        let response = admin_get(&router, &format!("{url}{suffix}"), Some(ADMIN)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()["content-length"],
            expected.len().to_string()
        );
        let disposition = response.headers()["content-disposition"].to_str().unwrap();
        assert!(
            disposition.contains("%E7%AC%94%E8%AE%B0%20%23100%25.md"),
            "{disposition}"
        );
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            expected
        );
    }
    // Reading a retained version must not use an externally edited projection.
    std::fs::write(dir.path().join("vault").join(path), b"edited projection").unwrap();
    let response = admin_get(&router, url, Some(ADMIN)).await;
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        b"updated".as_slice()
    );
    for suffix in ["?revision=999", "?revision=3"] {
        assert_eq!(
            admin_get(&router, &format!("{url}{suffix}"), Some(ADMIN))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    for suffix in [
        "?revision=0",
        "?revision=-1",
        "?revision=bad",
        "?unexpected=true",
    ] {
        assert!(
            admin_get(&router, &format!("{url}{suffix}"), Some(ADMIN))
                .await
                .status()
                .is_client_error()
        );
    }
    assert_eq!(
        request(
            &router,
            "POST",
            "/v1/configuration/operations",
            ADMIN,
            put("admin-config", "private-config", "app.json", 0, &second, 7)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        admin_get(
            &router,
            "/v1/admin/files/private-config/content",
            Some(ADMIN)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin_get(
            &router,
            "/v1/admin/files/admin-file/content?revision=3",
            Some(ADMIN)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(operation(&router, ADMIN, json!({"operation_id":"admin-delete","kind":"delete","file_id":"admin-file","base_revision":2})).await.0, StatusCode::OK);
    assert_eq!(
        admin_get(&router, url, Some(ADMIN)).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin_get(&router, &format!("{url}?revision=4"), Some(ADMIN))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin_get(&router, &format!("{url}?revision=1"), Some(ADMIN))
            .await
            .status(),
        StatusCode::OK
    );
    // All exports are read-only and leave the committed revision unchanged.
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        4
    );
    std::fs::write(dir.path().join("objects").join(first), b"corrupt object").unwrap();
    assert_eq!(
        admin_get(&router, &format!("{url}?revision=1"), Some(ADMIN))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn admin_export_streams_chunks_empty_files_and_bounds_preview() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture_with_limit(2 * 1024 * 1024).await;
    let bytes = vec![b'x'; 1024 * 1024 + 1];
    let mut parts = Vec::new();
    for chunk in bytes.chunks(65536) {
        parts.push(json!({"hash":upload_chunk(&router, chunk).await,"size":chunk.len()}));
    }
    let body = chunk_put(
        "admin-chunk-op",
        "admin-chunked",
        "large.md",
        0,
        &bytes,
        &json!(parts),
    );
    let (status, value) = operation(&router, ADMIN, body).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let path = "/v1/admin/files/admin-chunked/content";
    let response = admin_get(&router, path, Some(ADMIN)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        bytes
    );
    let response = admin_get(&router, &format!("{path}?preview=true"), Some(ADMIN)).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let empty = upload(&router, ADMIN, b"").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("admin-empty-op", "admin-empty", "empty.md", 0, &empty, 0)
        )
        .await
        .0,
        StatusCode::OK
    );
    let response = admin_get(
        &router,
        "/v1/admin/files/admin-empty/content?preview=true",
        Some(ADMIN),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], "0");
    assert!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    let hash = value["file"]["chunks"][0]["hash"].as_str().unwrap();
    std::fs::write(dir.path().join("objects").join(hash), b"invalid chunk").unwrap();
    assert_eq!(
        admin_get(&router, path, Some(ADMIN)).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

/// A device-token request with optional reported client details, so device
/// activity, version, and platform reporting can be observed without the admin session.
async fn device_get(
    router: &Router,
    token: &str,
    version: Option<&str>,
    platform: Option<&str>,
) -> StatusCode {
    let mut builder = Request::builder()
        .uri("/v1/info")
        .header("authorization", format!("Bearer {token}"));
    if let Some(version) = version {
        builder = builder.header("x-mindsync-client", version);
    }
    if let Some(platform) = platform {
        builder = builder.header("x-mindsync-platform", platform);
    }
    router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
        .status()
}
async fn device_entry(router: &Router, id: &str) -> Value {
    let (_, list) = request(router, "GET", "/v1/devices", ADMIN, Value::Null).await;
    list["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|device| device["id"] == id)
        .cloned()
        .expect("the device is registered")
}
#[tokio::test]
async fn admin_restore_appends_a_revision_and_preserves_history() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let original = upload(&router, ADMIN, b"# Original\n").await;
    let (_, first) = operation(
        &router,
        ADMIN,
        put("restore-1", "note-1", "notes/a.md", 0, &original, 11),
    )
    .await;
    let edited = upload(&router, ADMIN, b"# Edited\n").await;
    let (_, second) = operation(
        &router,
        ADMIN,
        put(
            "restore-2",
            "note-1",
            "notes/a.md",
            first["file"]["revision"].as_i64().unwrap(),
            &edited,
            9,
        ),
    )
    .await;
    assert_eq!(second["file"]["revision"], 2);
    // Only an administrator session can restore, and only through this route.
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"restore-device"}),
    )
    .await;
    let (status, _) = request(
        &router,
        "POST",
        "/v1/admin/files/note-1/restore",
        device["token"].as_str().unwrap(),
        json!({"revision":1}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for (path, body) in [
        ("/v1/admin/files/absent/restore", json!({"revision":1})),
        ("/v1/admin/files/note-1/restore", json!({"revision":99})),
        ("/v1/admin/files/note-1/restore", json!({"revision":0})),
        (
            "/v1/admin/files/note-1/restore",
            json!({"revision":1,"extra":true}),
        ),
    ] {
        let (status, _) = request(&router, "POST", path, ADMIN, body).await;
        assert!(
            matches!(
                status,
                StatusCode::NOT_FOUND | StatusCode::UNPROCESSABLE_ENTITY
            ),
            "{path} returned {status}"
        );
    }
    // The retained revision becomes a new head revision.
    let (status, restored) = request(
        &router,
        "POST",
        "/v1/admin/files/note-1/restore",
        ADMIN,
        json!({"revision":1}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["file"]["revision"], 3);
    assert_eq!(restored["file"]["hash"], original);
    assert_eq!(restored["file"]["path"], "notes/a.md");
    assert_eq!(restored["cursor"], 3);
    assert_eq!(
        std::fs::read(dir.path().join("vault/notes/a.md")).unwrap(),
        b"# Original\n"
    );
    // History keeps every earlier revision and the restore itself.
    let (_, history) = request(
        &router,
        "GET",
        "/v1/files/note-1/history",
        ADMIN,
        Value::Null,
    )
    .await;
    let versions = history["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 3);
    assert_eq!(versions[0]["hash"], original);
    assert_eq!(versions[1]["hash"], edited);
    assert_eq!(versions[2]["hash"], original);
    // Deleting and restoring the deletion brings the file back at its retained path.
    let (_, deleted) = operation(
        &router,
        ADMIN,
        json!({"operation_id":"restore-3","kind":"delete","file_id":"note-1","base_revision":3}),
    )
    .await;
    assert_eq!(deleted["file"]["deleted"], true);
    let (status, _) = request(
        &router,
        "POST",
        "/v1/admin/files/note-1/restore",
        ADMIN,
        json!({"revision":4}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, restored) = request(
        &router,
        "POST",
        "/v1/admin/files/note-1/restore",
        ADMIN,
        json!({"revision":3}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["file"]["deleted"], false);
    assert_eq!(restored["file"]["revision"], 5);
    // A chunked revision restores with its whole manifest, not as one object.
    let left = upload_chunk(&router, b"left").await;
    let right = upload_chunk(&router, b"right").await;
    let chunks = json!([{"hash":left,"size":4},{"hash":right,"size":5}]);
    let (_, chunked) = operation(
        &router,
        ADMIN,
        chunk_put("restore-4", "note-2", "bin/b.bin", 0, b"leftright", &chunks),
    )
    .await;
    let single = upload(&router, ADMIN, b"small").await;
    operation(
        &router,
        ADMIN,
        put(
            "restore-5",
            "note-2",
            "bin/b.bin",
            chunked["file"]["revision"].as_i64().unwrap(),
            &single,
            5,
        ),
    )
    .await;
    let (status, restored) = request(
        &router,
        "POST",
        "/v1/admin/files/note-2/restore",
        ADMIN,
        json!({"revision":chunked["file"]["revision"].as_i64().unwrap()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["file"]["chunked"], true);
    assert_eq!(restored["file"]["chunks"].as_array().unwrap().len(), 2);
    assert_eq!(
        std::fs::read(dir.path().join("vault/bin/b.bin")).unwrap(),
        b"leftright"
    );
    // A configuration-scope record never reaches the notes commit path.
    let configuration = b"{\"appearance\":1}".to_vec();
    let configuration_hash = upload(&router, ADMIN, &configuration).await;
    let (status, rejected) = request(
        &router,
        "POST",
        "/v1/configuration/operations",
        ADMIN,
        put(
            "restore-config",
            "config-1",
            "appearance.json",
            0,
            &configuration_hash,
            configuration.len(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rejected}");
    let (status, _) = request(
        &router,
        "POST",
        "/v1/admin/files/config-1/restore",
        ADMIN,
        json!({"revision":1}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn device_details_record_activity_and_allow_renaming() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, _dir) = fixture().await;
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"Laptop"}),
    )
    .await;
    let id = device["id"].as_str().unwrap();
    let token = device["token"].as_str().unwrap();
    let entry = device_entry(&router, id).await;
    assert!(entry["created_at"].as_i64().unwrap() > 0);
    assert!(entry["last_seen_at"].is_null());
    assert!(entry["client_version"].is_null());
    assert!(entry["client_platform"].is_null());
    // A device request records the activity time and the reported plugin details.
    assert_eq!(
        device_get(&router, token, Some("0.3.7"), Some("tablet-android")).await,
        StatusCode::OK
    );
    let entry = device_entry(&router, id).await;
    let seen = entry["last_seen_at"].as_i64().unwrap();
    assert!(seen > 0);
    assert_eq!(entry["client_version"], "0.3.7");
    assert_eq!(entry["client_platform"], "tablet-android");
    // The timestamp is throttled, so an active device does not write per request.
    assert_eq!(
        device_get(&router, token, Some("0.3.7"), Some("tablet-android")).await,
        StatusCode::OK
    );
    assert_eq!(device_entry(&router, id).await["last_seen_at"], seen);
    // A changed version is recorded immediately without waiting for the window.
    assert_eq!(
        device_get(&router, token, Some("0.3.8"), Some("tablet-android")).await,
        StatusCode::OK
    );
    let entry = device_entry(&router, id).await;
    assert_eq!(entry["client_version"], "0.3.8");
    assert_eq!(entry["last_seen_at"], seen);
    // So is a changed platform, which is how a device is distinguished without
    // waiting for the next five-minute write.
    assert_eq!(
        device_get(&router, token, Some("0.3.8"), Some("phone-ios")).await,
        StatusCode::OK
    );
    let entry = device_entry(&router, id).await;
    assert_eq!(entry["client_platform"], "phone-ios");
    assert_eq!(entry["last_seen_at"], seen);
    // A hostile or oversized version or platform is ignored instead of stored.
    assert_eq!(
        device_get(
            &router,
            token,
            Some(&"v".repeat(65)),
            Some("TABLET ANDROID!"),
        )
        .await,
        StatusCode::OK
    );
    let entry = device_entry(&router, id).await;
    assert_eq!(entry["client_version"], "0.3.8");
    assert_eq!(entry["client_platform"], "phone-ios");
    // Renaming is administrator-only and validates the name.
    let (status, renamed) = request(
        &router,
        "PATCH",
        &format!("/v1/devices/{id}"),
        ADMIN,
        json!({"name":"  Studio Mac  "}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["name"], "Studio Mac");
    assert_eq!(device_entry(&router, id).await["name"], "Studio Mac");
    for (path, body, expected) in [
        (
            format!("/v1/devices/{id}"),
            json!({"name":"   "}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "/v1/devices/absent".to_string(),
            json!({"name":"Other"}),
            StatusCode::NOT_FOUND,
        ),
        (
            format!("/v1/devices/{id}"),
            json!({"name":"Other","token":"steal"}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let (status, _) = request(&router, "PATCH", &path, ADMIN, body).await;
        assert_eq!(status, expected, "{path}");
    }
    let (status, _) = request(
        &router,
        "PATCH",
        &format!("/v1/devices/{id}"),
        token,
        json!({"name":"Taken over"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Revocation stops the requests and leaves the recorded details intact.
    request(
        &router,
        "DELETE",
        &format!("/v1/devices/{id}"),
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(
        device_get(&router, token, Some("0.3.9"), Some("desktop-macos")).await,
        StatusCode::UNAUTHORIZED
    );
    let entry = device_entry(&router, id).await;
    assert_eq!(entry["revoked"], true);
    assert_eq!(entry["last_seen_at"], seen);
    assert_eq!(entry["client_version"], "0.3.8");
    assert_eq!(entry["client_platform"], "phone-ios");
}

#[tokio::test]
async fn gc_status_reports_only_applied_collections() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"gc-device"}),
    )
    .await;
    let (status, _) = request(
        &router,
        "GET",
        "/v1/maintenance/gc",
        device["token"].as_str().unwrap(),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, status_body) =
        request(&router, "GET", "/v1/maintenance/gc", ADMIN, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(status_body["last_collection"].is_null());
    assert!(status_body["grace_seconds"].as_u64().unwrap() > 0);
    // An uploaded object that no version references is eligible after the grace period.
    upload(&router, ADMIN, b"orphan").await;
    age_objects(dir.path());
    let (_, preview) = request(&router, "POST", "/v1/maintenance/gc", ADMIN, json!({})).await;
    assert_eq!(preview["objects"], 1);
    let (_, status_body) = request(&router, "GET", "/v1/maintenance/gc", ADMIN, Value::Null).await;
    assert!(
        status_body["last_collection"].is_null(),
        "a preview must not be recorded as a collection"
    );
    let (_, collected) = request(
        &router,
        "POST",
        "/v1/maintenance/gc",
        ADMIN,
        json!({"dry_run":false}),
    )
    .await;
    assert_eq!(collected["objects"], 1);
    let (_, status_body) = request(&router, "GET", "/v1/maintenance/gc", ADMIN, Value::Null).await;
    assert_eq!(status_body["last_collection"]["objects"], 1);
    assert_eq!(status_body["last_collection"]["bytes"], 6);
    assert!(status_body["last_collection"]["at"].as_i64().unwrap() > 0);
    // A later collection with nothing eligible replaces the recorded numbers.
    request(
        &router,
        "POST",
        "/v1/maintenance/gc",
        ADMIN,
        json!({"dry_run":false}),
    )
    .await;
    let (_, status_body) = request(&router, "GET", "/v1/maintenance/gc", ADMIN, Value::Null).await;
    assert_eq!(status_body["last_collection"]["objects"], 0);
    assert_eq!(status_body["last_collection"]["bytes"], 0);
}
