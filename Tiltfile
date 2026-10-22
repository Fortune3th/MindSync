analytics_settings(False)
disable_snapshots()
docker_prune_settings(disable=True)
docker_compose('dev/compose.yaml', env_file='dev/development.env', project_name='mindsync-dev')

docker_build(
    'mindsync-dev-backend', '.', dockerfile='dev/backend.Dockerfile',
    only=['server/src', 'server/migrations', 'server/Cargo.toml', 'server/Cargo.lock', 'dev/backend.Dockerfile'],
    ignore=['server/src/admin'],
    live_update=[
        fall_back_on(['server/Cargo.toml', 'server/Cargo.lock', 'dev/backend.Dockerfile']),
        sync('server/src', '/workspace/server/src'),
        sync('server/migrations', '/workspace/server/migrations'),
        run('cd /workspace/server && cargo build --locked --features dev-assets'),
        restart_container(),
    ],
)
docker_build(
    'mindsync-dev-frontend', '.', dockerfile='dev/frontend/Dockerfile',
    only=['dev/frontend', 'server/src/admin'],
    ignore=['dev/frontend/node_modules'],
    live_update=[
        fall_back_on(['dev/frontend/package.json', 'dev/frontend/package-lock.json', 'dev/frontend/Dockerfile', 'dev/frontend/vite.config.mjs']),
        sync('server/src/admin', '/app/src/admin'),
    ],
)
dc_resource('postgres', labels=['Development'])
dc_resource('backend', resource_deps=['postgres'], labels=['Development'], links=[link('http://localhost:18089/health', 'Axum health')])
dc_resource('frontend', resource_deps=['backend'], labels=['Development'], links=[link('http://localhost:5173', 'MindSync Admin')])

dc_resource('mailpit', labels=['Development'], links=[link('http://localhost:18025', 'Test inbox')])
