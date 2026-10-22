// Run only against a disposable, loopback-bound MindSync library.
// Start that server with MINDSYNC_GC_GRACE_SECONDS=0 so the fixture object that
// no version references is immediately eligible for collection.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const base = new URL(process.env.MINDSYNC_BROWSER_URL || 'http://127.0.0.1:18090');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || process.env.MINDSYNC_ADMIN_BROWSER_TEST !== '1') {
  throw new Error('Set MINDSYNC_ADMIN_BROWSER_TEST=1 and use a disposable loopback server. This test creates fixture notes and devices.');
}
if (['5173', '18089'].includes(base.port)) {
  throw new Error('The shared development preview must stay free of test fixtures. Use a separate disposable server, such as port 18090.');
}
const email = process.env.MINDSYNC_TEST_ADMIN_EMAIL;
const password = process.env.MINDSYNC_TEST_ADMIN_PASSWORD;
assert.ok(email && password, 'MINDSYNC_TEST_ADMIN_EMAIL and MINDSYNC_TEST_ADMIN_PASSWORD are required');
let admin;
const {chromium} = await import(process.env.MINDSYNC_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.MINDSYNC_BROWSER_OUTPUT || '/tmp/mindsync-admin-browser-check';
await mkdir(output, {recursive: true});
const prefix = `browser-${randomUUID().slice(0, 8)}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function api(path, method = 'GET', body, token = admin) {
  const response = await fetch(new URL(path, base), {method, headers: {Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)});
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
async function put(path, text, id = randomUUID(), revision = 0) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const digest = hash(bytes);
  const response = await fetch(new URL(`/v1/objects/${digest}`, base), {method: 'PUT', headers: {Authorization: `Bearer ${admin}`}, body: bytes});
  assert.equal(response.status, 200);
  return (await api('/v1/operations', 'POST', {operation_id: randomUUID(), kind: 'put', file_id: id, path, base_revision: revision, hash: digest, size: bytes.length})).file;
}
// A stored object that no version references is what manual collection reclaims.
async function putOrphan(text) {
  const bytes = Buffer.from(text);
  const digest = hash(bytes);
  const response = await fetch(new URL(`/v1/objects/${digest}`, base), {method: 'PUT', headers: {Authorization: `Bearer ${admin}`}, body: bytes});
  assert.equal(response.status, 200);
  return digest;
}
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(new URL('/health', base), {signal: AbortSignal.timeout(2000)});
    if (response.ok) break;
  } catch { /* The isolated service may still be rebuilding its readable tree. */ }
  if (attempt >= 59) throw new Error('The disposable browser-test server did not become healthy.');
  await new Promise(resolve => setTimeout(resolve, 250));
}
const login = await fetch(new URL('/v1/auth/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,cli:true})});
assert.equal(login.status,200);admin = (await login.json()).session_token;
const markdown = `# Browser fixture\n\n<script>window.noteExecuted = true</script>\n\n${'\u7b14\u8bb0'} content stays literal.\n`;
const first = await put(`${prefix}/notes/\u7b14\u8bb0 #100%.md`, '# Original revision\n');
const current = await put(first.path, markdown, first.id, first.revision);
const empty = await put(`${prefix}/empty.md`, '');
const binary = await put(`${prefix}/attachment.bin`, Buffer.from([0, 1, 2, 255]));
const deleted = await put(`${prefix}/deleted.md`, '# Retained after deletion\n');
await api('/v1/operations', 'POST', {operation_id: randomUUID(), kind: 'delete', file_id: deleted.id, base_revision: deleted.revision});
for (let i = 0; i < 53; i++) await put(`${prefix}/archive/note-${String(i).padStart(2, '0')}.md`, `# Archive ${i}\n`);
const large = await put(`${prefix}/large.txt`, Buffer.alloc(1024 * 1024 + 1, 97));
const orphan = await putOrphan(`${prefix} unreferenced object`);
const apiDevice = await api('/v1/devices', 'POST', {name: `${prefix} API fixture`});
const expectedFiles = (await api('/v1/snapshot')).files.filter(file => !file.deleted).length;
const browser = await chromium.launch({headless: true, ...(process.env.MINDSYNC_BROWSER_EXECUTABLE ? {executablePath: process.env.MINDSYNC_BROWSER_EXECUTABLE} : {})});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
// Exercise the manual-copy path used by browsers on plain HTTP NAS addresses.
await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true}));
const page = await context.newPage();
const errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()); });
page.on('request', request => { if (new URL(request.url()).origin !== base.origin) external.push(request.url()); });
const waitText = (locator, text) => locator.filter({hasText: text}).waitFor();
async function signIn(credential = password) {
  await page.locator('#admin-email').fill(email);
  await page.locator('#admin-password').fill(credential);
  await page.locator('#sign-in').click();
}
async function openFile(name) {
  await page.locator('#file-search').fill(name);
  const row = page.locator('.file-row').filter({hasText: name.split('/').pop()});
  await row.first().click();
  await page.locator('#file-version:not([disabled])').waitFor();
}
async function noOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page overflows horizontally');
}
try {
  const noScript = await browser.newContext({javaScriptEnabled: false});
  const fallback = await noScript.newPage();
  await fallback.goto(base.href);
  const probe = 'nonsecret-native-form-probe';
  await fallback.locator('#admin-email').fill(email);
  await fallback.locator('#admin-password').fill(probe);
  const nativeRequest = fallback.waitForRequest(request => request.isNavigationRequest() && request.method() === 'POST');
  await fallback.locator('#sign-in').click();
  const submitted = await nativeRequest;
  assert.equal(new URL(submitted.url()).search, '');
  assert.equal((submitted.postData() || '').includes(probe), false);
  await noScript.close();
  await page.goto(base.href);
  await page.locator('#admin-password').waitFor();
  assert.equal(await page.locator('.hint, .eyebrow, .sidebar-caption, .page-footer').count(), 0);
  assert.equal(await page.locator('label[for="admin-password"]').textContent(),'Password');
  assert.equal(await page.locator('body').innerText().then(text=>/setup credential|NAS terminal|environment file|admin token/i.test(text)),false);
  await page.locator('#forgot-password').click();
  await page.getByRole('heading',{name:'Reset password',exact:true}).waitFor();
  await page.locator('#back-to-login').click();
  await signIn(apiDevice.token);
  await waitText(page.locator('#login-error'), 'Invalid email, password, or session');
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#admin-password').inputValue(), apiDevice.token);
  await signIn();
  await waitText(page.locator('#stat-files'), String(expectedFiles));
  await noOverflow();
  await page.screenshot({path: join(output, 'overview-desktop.png'), fullPage: true});
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.ok((await context.cookies()).some(cookie => cookie.name.startsWith('mindsync_session_') && cookie.httpOnly && cookie.sameSite === 'Strict'));
  await page.reload();
  await page.locator('#workspace').waitFor();
  await page.locator('[data-page="settings"]').click();
  await waitText(page.locator('#settings-server'), base.origin);
  await page.locator('#copy-server').click();
  await waitText(page.locator('#copy-server'), 'Selected');
  await page.locator('#theme').selectOption('dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.locator('#theme').selectOption('system');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.locator('[data-page="devices"]').click();
  const hostileName = `${prefix} Android <img src=x onerror=window.deviceExecuted=true>`;
  await page.locator('#device-name').fill(hostileName);
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/v1/devices') && response.request().method() === 'POST');
  await page.locator('#register-device').click();
  const created = await (await createdResponse).json();
  await page.locator('#new-credential').waitFor();
  assert.equal((await page.locator('#created-token').inputValue()).length, 64);
  assert.equal(await page.locator('#register-device').isDisabled(), true);
  await page.locator('#copy-token').click();
  await waitText(page.locator('#copy-token'), 'Selected');
  assert.equal(await page.locator('#created-token').evaluate(node => node.selectionEnd - node.selectionStart), 64);
  await page.locator('#dismiss-token').click();
  assert.equal(await page.locator('#created-token').inputValue(), '');
  const row = page.locator('.device-row').filter({hasText: hostileName});
  await row.waitFor();
  assert.equal(await row.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.deviceExecuted), undefined);
  await row.getByRole('button', {name: 'Revoke', exact: true}).click();
  await page.locator('#cancel-revoke').click();
  assert.equal((await api('/v1/devices')).devices.find(device => device.id === created.id).revoked, false);
  await row.getByRole('button', {name: 'Revoke', exact: true}).click();
  await page.locator('#confirm-revoke').click();
  await waitText(row.locator('.badge'), 'Revoked');
  assert.equal((await fetch(new URL('/v1/info', base), {headers: {Authorization: `Bearer ${created.token}`}})).status, 401);
  // A device request records its reported plugin version and last activity time.
  const deviceRequest = await fetch(new URL('/v1/info', base), {headers: {Authorization: `Bearer ${created.token}`}});
  assert.equal(deviceRequest.status, 401, 'a revoked credential must not record activity');
  const live = await api('/v1/devices', 'POST', {name: `${prefix} activity fixture`});
  assert.equal((await fetch(new URL('/v1/info', base), {headers: {Authorization: `Bearer ${live.token}`, 'X-MindSync-Client': '9.9.9'}})).status, 200);
  await page.locator('[data-page="overview"]').click();
  await page.locator('[data-page="devices"]').click();
  await page.locator('#refresh').click();
  const liveRow = page.locator('.device-row').filter({hasText: `${prefix} activity fixture`});
  await liveRow.waitFor();
  await waitText(liveRow.locator('.device-meta'), 'Plugin 9.9.9');
  assert.ok((await liveRow.locator('.device-meta').textContent()).includes('Last request'));
  // Renaming validates the name, keeps the credential and is administrator-only.
  await liveRow.getByRole('button', {name: 'Rename', exact: true}).click();
  await page.locator('#rename-name').waitFor();
  assert.equal(await page.locator('#rename-name').inputValue(), `${prefix} activity fixture`);
  await page.locator('#rename-name').fill('   ');
  await page.locator('#confirm-rename').click();
  await waitText(page.locator('#rename-error'), 'Enter a device name');
  await page.locator('#rename-name').fill(`${prefix} renamed device`);
  await page.locator('#confirm-rename').click();
  await waitText(page.locator('#notice'), 'Renamed');
  const renamedRow = page.locator('.device-row').filter({hasText: `${prefix} renamed device`});
  await renamedRow.waitFor();
  assert.equal(await renamedRow.locator('.device-meta').count(), 1);
  const renamed = (await api('/v1/devices')).devices.find(device => device.id === live.id);
  assert.equal(renamed.name, `${prefix} renamed device`);
  assert.equal((await fetch(new URL('/v1/info', base), {headers: {Authorization: `Bearer ${live.token}`}})).status, 200);
  const limit = await fetch(new URL(`/v1/devices/${live.id}`, base), {method: 'PATCH', headers: {Authorization: `Bearer ${live.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Taken over'})});
  assert.equal(limit.status, 403);
  await page.locator('[data-page="maintenance"]').click();
  await waitText(page.locator('#gc-last'), 'Never');
  await page.locator('#gc-preview').click();
  await waitText(page.locator('#gc-objects'), '1');
  assert.equal(await page.locator('#gc-apply').isDisabled(), false);
  await page.locator('#gc-apply').click();
  await waitText(page.locator('#gc-confirm'), '1 unreferenced object (');
  await page.locator('#cancel-gc').click();
  assert.equal((await api('/v1/maintenance/gc')).last_collection, null);
  await page.screenshot({path: join(output, 'maintenance-desktop.png'), fullPage: true});
  await page.locator('#gc-apply').click();
  await page.locator('#confirm-gc').click();
  await waitText(page.locator('#gc-message'), 'Collected 1 unreferenced object (');
  await waitText(page.locator('#gc-objects'), '0');
  assert.equal(await page.locator('#gc-apply').isDisabled(), true);
  assert.equal((await api('/v1/maintenance/gc')).last_collection.objects, 1);
  // The recorded collection reaches the page through the refresh that follows the
  // mutation, so wait for it instead of racing that request.
  await page.waitForFunction(() => document.getElementById('gc-last').textContent !== 'Never');
  assert.notEqual(await page.locator('#gc-last').textContent(), 'Never');
  assert.ok((await api('/v1/maintenance/gc')).last_collection.bytes > 0);
  await page.locator('[data-page="files"]').click();
  await page.locator('#file-search').fill(prefix);
  assert.equal(await page.locator('.file-row').count(), 57);
  assert.ok(await page.locator('#file-list').evaluate(node => node.scrollHeight > node.clientHeight));
  await page.locator('.file-row').last().scrollIntoViewIfNeeded();
  await openFile(current.path);
  await page.locator('#preview-file').click();
  await page.locator('#file-preview').waitFor();
  assert.equal(await page.locator('#file-preview').textContent(), markdown);
  assert.equal(await page.evaluate(() => window.noteExecuted), undefined);
  await page.locator('#file-version').selectOption(String(first.revision));
  await page.locator('#preview-file').click();
  await waitText(page.locator('#file-preview'), 'Original revision');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-file').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), first.path.split('/').pop());
  assert.equal((await readFile(await download.path())).toString(), '# Original revision\n');
  await page.locator('#file-version').selectOption(String(current.revision));
  await page.locator('#preview-file').click();
  await page.locator('#file-preview').waitFor();
  await page.screenshot({path: join(output, 'files-desktop.png'), fullPage: true});
  // Restoring the retained revision appends a head revision instead of rewriting history.
  assert.equal(await page.locator('#restore-file').isDisabled(), true);
  await page.locator('#file-version').selectOption(String(first.revision));
  assert.equal(await page.locator('#restore-file').isDisabled(), false);
  await page.locator('#restore-file').click();
  await page.locator('#restore-dialog').waitFor();
  assert.ok((await page.locator('#restore-name').textContent()).includes(`revision ${first.revision}`));
  await page.locator('#cancel-restore').click();
  const before = (await api(`/v1/files/${current.id}/history`)).versions;
  assert.equal(before.length, 2, 'the fixture keeps two revisions before restoring');
  await page.locator('#restore-file').click();
  await page.locator('#confirm-restore').click();
  await waitText(page.locator('#notice'), 'as the new revision');
  const restored = (await api(`/v1/files/${current.id}/history`)).versions;
  assert.equal(restored.length, 3, 'restoring appends one revision');
  assert.equal(restored[restored.length - 1].hash, first.hash);
  assert.ok(restored[2].revision > current.revision, 'the restored revision is a new head');
  await page.locator(`#file-version option[value="${restored[2].revision}"]`).waitFor({state: 'attached'});
  assert.equal(await page.locator('#file-version').inputValue(), String(restored[2].revision));
  await page.locator('#preview-file').click();
  await waitText(page.locator('#file-preview'), 'Original revision');
  assert.equal(await page.locator('#file-version').isDisabled(), false);
  await openFile(empty.path);
  await page.locator('#preview-file').click();
  await waitText(page.locator('#file-message'), 'Empty file');
  await openFile(binary.path);
  await page.locator('#preview-file').click();
  await waitText(page.locator('#file-message'), 'Not a UTF-8 text file');
  await openFile(large.path);
  assert.equal(await page.locator('#preview-file').isDisabled(), true);
  await waitText(page.locator('#file-message'), 'Preview exceeds 1 MiB');
  await page.locator('#file-search').fill(deleted.path);
  assert.equal(await page.locator('.file-row').count(), 0);
  await page.locator('#show-deleted').check();
  await openFile(deleted.path);
  await page.locator('#preview-file').click();
  await waitText(page.locator('#file-preview'), 'Retained after deletion');
  // A delayed history response cannot replace a more recently selected file.
  let releaseHistory, historyStarted;
  const historyReady = new Promise(resolve => { historyStarted = resolve; });
  const historyRelease = new Promise(resolve => { releaseHistory = resolve; });
  await page.route(`**/v1/files/${current.id}/history`, async route => { historyStarted(); await historyRelease; await route.continue(); });
  await page.locator('#file-search').fill(current.path);
  await page.locator('.file-row').first().click(); await historyReady;
  await openFile(empty.path);
  const oldHistoryResponse = page.waitForResponse(response => response.url().endsWith(`/v1/files/${current.id}/history`));
  releaseHistory();
  await oldHistoryResponse;
  await page.unroute(`**/v1/files/${current.id}/history`);
  assert.equal(await page.locator('#selected-path').textContent(), empty.path);
  // A response completing after sign-out must not repopulate private data.
  let releaseRefresh, refreshStarted;
  const refreshReady = new Promise(resolve => { refreshStarted = resolve; });
  const refreshRelease = new Promise(resolve => { releaseRefresh = resolve; });
  await page.route('**/v1/snapshot', async route => { refreshStarted(); await refreshRelease; try { await route.continue(); } catch { /* Sign-out aborts the request. */ } });
  await page.locator('#refresh').click(); await refreshReady;
  await page.locator('#sign-out').click(); releaseRefresh();
  await page.unroute('**/v1/snapshot');
  await page.locator('#login').waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#file-list').textContent(), '');
  assert.equal(await page.locator('#selected-path').textContent(), '');
  assert.equal(await page.locator('#file-preview').textContent(), '');
  assert.equal(await page.locator('#created-token').inputValue(), '');
  await page.setViewportSize({width: 375, height: 812});
  await noOverflow();
  await page.screenshot({path: join(output, 'login-mobile.png'), fullPage: true});
  await signIn();
  await page.locator('[data-page="overview"]').click();
  await waitText(page.locator('#stat-files'), String(expectedFiles));
  await noOverflow();
  await page.screenshot({path: join(output, 'overview-mobile.png'), fullPage: true});
  await page.locator('[data-page="devices"]').click();
  await noOverflow();
  await page.screenshot({path: join(output, 'devices-mobile.png'), fullPage: true});
  await page.locator('[data-page="maintenance"]').click();
  await noOverflow();
  await page.screenshot({path: join(output, 'maintenance-mobile.png'), fullPage: true});
  await page.locator('[data-page="files"]').click(); await openFile(current.path);
  await page.locator('#preview-file').click(); await page.locator('#file-preview').waitFor();
  await noOverflow();
  await page.screenshot({path: join(output, 'files-mobile.png'), fullPage: true});
  await page.emulateMedia({colorScheme: 'dark', reducedMotion: 'reduce'});
  await page.locator('[data-page="overview"]').click(); await noOverflow();
  await page.screenshot({path: join(output, 'overview-mobile-dark.png'), fullPage: true});
  await page.setViewportSize({width: 812, height: 375}); await noOverflow();
  await page.locator('#sign-out').click();
  await page.locator('#login').waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#forgot-password').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({passed: true, checks: ['no-script credential protection', 'admin authentication', 'standard password recovery', 'Settings navigation and theme', 'device-token rejection', 'device registration', 'one-time token display', 'manual copy fallback', 'revoke cancellation and confirmation', 'device activity, plugin version and rename', 'unreferenced-object preview, cancellation and collection', 'historical revision restore with retained history', 'scrollable file list and search', 'literal UTF-8 preview', 'history selection and download', 'empty and binary files', 'large-preview limit', 'deleted-file history', 'stale-selection protection', 'logout race', '375px desktop/mobile/dark/landscape layouts', 'keyboard focus', 'HttpOnly session and no browser-stored passwords', 'no external requests'], screenshots: output}, null, 2));
} finally { await browser.close(); await fetch(new URL('/v1/auth/logout',base),{method:'POST',headers:{Authorization:`Bearer ${admin}`}}); }
