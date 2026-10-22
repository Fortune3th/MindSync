'use strict';

const $ = id => document.getElementById(id);
const pages = {overview: 'Overview', devices: 'Devices', files: 'Files', maintenance: 'Maintenance', settings: 'Settings'};
let csrfToken = '', authenticated = false, session = 0, sessionAbort = new AbortController();
let files = [], devices = [], selectedFile, selectedVersion, historyVersions = [];
let detailGeneration = 0, refreshGeneration = 0, refreshing = false, mutating = false;
let gcChecked; // The current session's preview result, never persisted.
let collectionGrace, collectionStorage, collectionLast;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function message(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
}
function showError(error) {
  if (error.name !== 'AbortError' && authenticated) message(error.message, true);
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${new Intl.NumberFormat('en', {maximumFractionDigits: unit ? 1 : 0}).format(bytes)} ${units[unit]}`;
}
// Device details come from the server: a missing timestamp or version stays unknown.
function formatTime(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleString([], {dateStyle: 'short', timeStyle: 'short'}) : '';
}
function deviceDetails(device) {
  const parts = [];
  if (device.created_at) parts.push(`Registered ${formatTime(device.created_at)}`);
  if (device.last_seen_at) parts.push(`Last request ${formatTime(device.last_seen_at)}`);
  if (device.client_version) parts.push(`Plugin ${device.client_version}`);
  return parts.length ? parts.join(' · ') : 'No recorded activity';
}
// Icons follow the reported form factor; unknown or older clients keep a generic
// computer icon instead of guessing from the device name.
function deviceKind(platform) {
  const kind = String(platform || '').split('-')[0];
  if (kind === 'phone' || kind === 'tablet' || kind === 'desktop') return kind;
  if (kind === 'mobile') return 'phone';
  return 'unknown';
}
function deviceIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shapes = {
    tablet: [['rect', {x: 4, y: 2, width: 16, height: 20, rx: 2.5}], ['path', {d: 'M10.5 18.5h3'}]],
    phone: [['rect', {x: 7, y: 2, width: 10, height: 20, rx: 2.5}], ['path', {d: 'M10.5 18.5h3'}]],
    desktop: [['rect', {x: 3, y: 4, width: 18, height: 12, rx: 2}], ['path', {d: 'M8 20h8M12 16v4'}]]
  };
  for (const [tag, attributes] of shapes[kind] || shapes.desktop) {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}
function resetSession(focus = true) {
  session++;
  sessionAbort.abort();
  sessionAbort = new AbortController();
  csrfToken = ''; authenticated = false; files = []; devices = []; revokeTarget = undefined;
  selectedFile = selectedVersion = undefined; historyVersions = [];
  renameTarget = restoreTarget = undefined; gcChecked = undefined;
  detailGeneration++; refreshGeneration++; refreshing = mutating = false;
  for (const id of ['device-list', 'file-list', 'file-version', 'file-preview', 'selected-path', 'selected-meta', 'file-message', 'revoke-name', 'revoke-error', 'rename-name', 'rename-error', 'restore-name', 'restore-error', 'gc-confirm', 'gc-error']) $(id).replaceChildren();
  for (const id of ['stat-files', 'stat-devices', 'stat-storage', 'stat-revision', 'library-name', 'settings-library-name', 'settings-server', 'sidebar-library', 'sidebar-storage', 'max-file', 'logical-size', 'protocol', 'config-support', 'last-refreshed', 'server-origin', 'device-count', 'file-count', 'gc-grace', 'gc-objects', 'gc-reclaimable', 'gc-last']) $(id).textContent = '—';
  for (const id of ['admin-password', 'confirm-password', 'current-password', 'new-password', 'new-password-confirmation', 'verification-code', 'device-name', 'created-token', 'file-search']) $(id).value = '';
  $('copy-server').textContent = 'Copy';
  $('show-deleted').checked = false;
  $('new-credential').hidden = $('file-selected').hidden = $('file-preview').hidden = $('gc-message').hidden = true;
  $('file-placeholder').hidden = false;
  $('login-error').hidden = true;
  $('workspace').hidden = true;
  $('login').hidden = false;
  gcChecked = undefined; renderCollection();
  for (const id of ['revoke-dialog', 'rename-dialog', 'restore-dialog', 'gc-dialog']) if ($(id).open) $(id).close();
  message(''); updateControls(); $('sign-in').textContent = 'Sign in';
  document.title = 'MindSync — Administration';
  if (focus) $('admin-email').focus();
}
async function api(path, options = {}) {
  const currentSession = session, controller = new AbortController();
  const sessionSignal = sessionAbort.signal;
  const abort = () => controller.abort();
  sessionSignal.addEventListener('abort', abort, {once: true});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
  try {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: {...(csrfToken ? {'X-CSRF-Token': csrfToken} : {}), ...(options.body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (currentSession !== session) throw new DOMException('Session ended', 'AbortError');
    if (!response.ok) {
      let reason;
      try { reason = (await response.json()).error?.message; } catch { /* A proxy may return a non-JSON error. */ }
      if (currentSession !== session) throw new DOMException('Session ended', 'AbortError');
      if ((response.status === 401 || response.status === 403) && authenticated) {
        resetSession();
        $('login-error').textContent = 'Session expired';
        $('login-error').hidden = false;
        throw new DOMException('Session ended', 'AbortError');
      }
      throw new Error(response.status === 401 || response.status === 403
        ? reason || 'Invalid email, password, or session'
        : reason || `The server returned HTTP ${response.status}. Try again.`);
    }
    const result = options.bytes ? await response.arrayBuffer() : await response.json();
    if (currentSession !== session) throw new DOMException('Session ended', 'AbortError');
    return result;
  } catch (error) {
    if (currentSession !== session) throw new DOMException('Session ended', 'AbortError');
    if (timedOut) throw new Error('Request timed out');
    if (error instanceof TypeError) throw new Error('Cannot reach the server');
    throw error;
  } finally {
    clearTimeout(timer);
    sessionSignal.removeEventListener('abort', abort);
  }
}
function updateControls() {
  $('refresh').disabled = refreshing || mutating;
  $('refresh').textContent = refreshing ? 'Refreshing…' : 'Refresh';
  $('register-device').disabled = mutating || refreshing || !$('new-credential').hidden;
  for (const button of document.querySelectorAll('.revoke-button')) button.disabled = mutating || refreshing;
  for (const button of document.querySelectorAll('.rename-button')) button.disabled = mutating || refreshing;
  $('confirm-revoke').disabled = mutating;
  $('cancel-revoke').disabled = mutating;
  $('confirm-rename').disabled = mutating;
  $('cancel-rename').disabled = mutating;
  $('confirm-restore').disabled = mutating;
  $('cancel-restore').disabled = mutating;
  $('confirm-gc').disabled = mutating;
  $('cancel-gc').disabled = mutating;
  if (authenticated) renderCollection();
  $('restore-file').disabled = mutating || refreshing || !selectedVersion || selectedVersion.revision === selectedFile?.revision;
  $('sign-in').disabled = false;
}
function showPage(page, focus = false) {
  if (!Object.hasOwn(pages, page)) page = 'overview';
  for (const section of document.querySelectorAll('[data-section]')) section.hidden = section.id !== page;
  for (const link of document.querySelectorAll('[data-page]')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('page-title').textContent = pages[page];
  document.title = `${pages[page]} — MindSync`;
  if (focus) $('main').focus();
}
async function refreshData() {
  if (refreshing || mutating) return;
  const generation = ++refreshGeneration;
  refreshing = true; updateControls();
  try {
    const [health, info, snapshot, registered, collection] = await Promise.all([
      api('/health'), api('/v1/info'), api('/v1/snapshot'), api('/v1/devices'), api('/v1/maintenance/gc'),
    ]);
    if (generation !== refreshGeneration) return;
    files = snapshot.files;
    devices = registered.devices;
    $('health-badge').textContent = health.status === 'ok' ? 'Healthy' : 'Check server';
    $('server-origin').textContent = location.origin;
    $('last-refreshed').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    $('stat-files').textContent = files.filter(file => !file.deleted).length.toLocaleString('en');
    $('stat-devices').textContent = devices.filter(device => !device.revoked).length.toLocaleString('en');
    $('stat-storage').textContent = formatBytes(info.storage_bytes);
    $('stat-revision').textContent = info.cursor.toLocaleString('en');
    $('library-name').textContent = $('settings-library-name').textContent = info.library_name || 'MindSync';
    $('sidebar-library').textContent = info.library_name || 'MindSync';
    $('sidebar-storage').textContent = formatBytes(info.storage_bytes);
    $('settings-server').textContent = location.origin;
    $('max-file').textContent = formatBytes(info.max_file_bytes);
    $('logical-size').textContent = formatBytes(info.logical_bytes);
    $('protocol').textContent = info.protocol;
    $('config-support').textContent = info.configuration_sync ? 'Available' : 'Unavailable';
    collectionGrace = collection.grace_seconds;
    collectionStorage = info.storage_bytes;
    collectionLast = collection.last_collection;
    renderDevices(); renderFiles(); renderCollection();
    if (selectedFile) {
      const current = files.find(file => file.id === selectedFile.id);
      if (current) await selectFile(current);
      else clearDetail();
    }
  } finally {
    if (generation === refreshGeneration) { refreshing = false; updateControls(); }
  }
}
function renderDevices() {
  const list = $('device-list'); list.replaceChildren();
  $('device-count').textContent = `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`;
  if (!devices.length) {
    const empty = element('div', 'empty-state');
    empty.append(document.querySelector('[data-page="devices"] svg').cloneNode(true), element('p', '', 'No devices'));
    list.append(empty); return;
  }
  for (const device of [...devices].sort((a, b) => Number(a.revoked) - Number(b.revoked) || a.name.localeCompare(b.name))) {
    const row = element('div', 'device-row');
    const kind = deviceKind(device.client_platform);
    const icon = element('span', 'device-icon');
    icon.title = {desktop: 'Computer', tablet: 'Tablet', phone: 'Phone'}[kind] || 'Device';
    icon.append(deviceIcon(kind));
    const info = element('div', 'device-info');
    info.append(element('strong', '', device.name), element('p', 'mono', device.id), element('p', 'device-meta', deviceDetails(device)));
    const actions = element('div', 'device-actions');
    actions.append(element('span', `badge ${device.revoked ? 'revoked' : 'success'}`, device.revoked ? 'Revoked' : 'Active'));
    const rename = element('button', 'rename-button', 'Rename');
    rename.addEventListener('click', () => openRename(device)); actions.append(rename);
    if (!device.revoked) {
      const revoke = element('button', 'revoke-button', 'Revoke');
      revoke.addEventListener('click', () => openRevoke(device)); actions.append(revoke);
    }
    row.append(icon, info, actions); list.append(row);
  }
  updateControls();
}
function renderCollection() {
  const badge = $('gc-badge');
  if (gcChecked) {
    badge.textContent = gcChecked.objects ? `${gcChecked.objects} eligible` : 'Up to date';
    badge.className = `badge ${gcChecked.objects ? '' : 'success'}`.trim();
    $('gc-objects').textContent = gcChecked.objects.toLocaleString('en');
    $('gc-reclaimable').textContent = formatBytes(gcChecked.bytes);
  } else {
    badge.textContent = 'Not checked';
    badge.className = 'badge';
    $('gc-objects').textContent = '—';
    $('gc-reclaimable').textContent = '—';
  }
  $('gc-grace').textContent = Number.isFinite(collectionGrace) ? `${collectionGrace.toLocaleString('en')} s` : '—';
  $('gc-storage').textContent = formatBytes(collectionStorage);
  $('gc-last').textContent = collectionLast
    ? `${formatTime(collectionLast.at)} · ${collectionLast.objects.toLocaleString('en')} objects · ${formatBytes(collectionLast.bytes)}`
    : 'Never';
  $('gc-apply').disabled = mutating || refreshing || !gcChecked?.objects;
  $('gc-preview').disabled = mutating || refreshing;
}
// Collection copy names the object and byte counts, including the singular form.
const gcCount = count => `${count.toLocaleString('en')} unreferenced ${count === 1 ? 'object' : 'objects'}`;
function collectionMessage(text, error = false) {
  $('gc-message').textContent = text;
  $('gc-message').classList.toggle('error', error);
  $('gc-message').hidden = !text;
}
function renderFiles() {
  const query = $('file-search').value.toLocaleLowerCase();
  const filtered = files.filter(file => ($('show-deleted').checked || !file.deleted) && file.path.toLocaleLowerCase().includes(query)).sort((a, b) => a.path.localeCompare(b.path));
  $('file-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'file' : 'files'}`;
  const list = $('file-list'), scrollTop = list.scrollTop; list.replaceChildren();
  if (!filtered.length) {
    const empty = element('div', 'empty-state');
    empty.append(document.querySelector('[data-page="files"] svg').cloneNode(true), element('p', '', query ? 'No matches' : 'No files'));
    list.append(empty);
  }
  for (const file of filtered) {
    const row = element('button', 'file-row');
    row.setAttribute('aria-pressed', String(selectedFile?.id === file.id));
    const path = file.path.split('/'), name = path.pop();
    const extension = name.includes('.') ? name.split('.').pop().slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    const icon = element('span', 'file-icon', extension || 'FILE'); icon.setAttribute('aria-hidden', 'true');
    const info = element('span', 'file-row-info');
    info.append(element('strong', '', name), element('span', '', `${path.length ? path.join('/') + ' · ' : ''}${file.deleted ? 'Deleted · ' : ''}Revision ${file.revision}`));
    row.append(icon, info, element('span', 'file-size', formatBytes(file.size)));
    row.addEventListener('click', () => { void selectFile(file); });
    list.append(row);
  }
  list.scrollTop = scrollTop;
}
function clearDetail() {
  detailGeneration++; selectedFile = selectedVersion = undefined; historyVersions = [];
  $('file-placeholder').hidden = false; $('file-selected').hidden = true;
  $('file-preview').hidden = true; $('file-preview').textContent = '';
  $('file-version').replaceChildren();
}
async function selectFile(file) {
  const generation = ++detailGeneration;
  selectedFile = file; selectedVersion = undefined; historyVersions = [];
  $('file-placeholder').hidden = true; $('file-selected').hidden = false;
  $('selected-path').textContent = file.path;
  $('selected-meta').textContent = `${formatBytes(file.size)} · ${file.deleted ? 'Deleted' : 'Current'} · revision ${file.revision}`;
  $('file-preview').hidden = true; $('file-preview').textContent = '';
  $('file-message').textContent = 'Loading…';
  $('file-version').replaceChildren();
  $('file-version').disabled = $('preview-file').disabled = $('download-file').disabled = true;
  renderFiles();
  try {
    const result = await api(`/v1/files/${encodeURIComponent(file.id)}/history`);
    if (generation !== detailGeneration) return;
    historyVersions = result.versions.sort((a, b) => b.revision - a.revision);
    for (const version of historyVersions) {
      const option = element('option', '', `Revision ${version.revision}${version.revision === file.revision ? ' · current' : ''}${version.deleted ? ' · deleted' : ''} · ${formatBytes(version.size)}`);
      option.value = String(version.revision); option.disabled = version.deleted;
      $('file-version').append(option);
    }
    const first = historyVersions.find(version => !version.deleted);
    if (first) $('file-version').value = String(first.revision);
    $('file-version').disabled = !first;
    chooseVersion();
  } catch (error) {
    if (generation === detailGeneration && error.name !== 'AbortError') $('file-message').textContent = `${error.message} Select the file again to retry.`;
  }
}
function chooseVersion() {
  detailGeneration++;
  selectedVersion = historyVersions.find(version => String(version.revision) === $('file-version').value && !version.deleted);
  $('file-preview').hidden = true; $('file-preview').textContent = '';
  $('download-file').disabled = !selectedVersion;
  $('preview-file').disabled = !selectedVersion || selectedVersion.size > 1024 * 1024;
  updateControls();
  $('file-message').textContent = !selectedVersion ? 'No retained content is available.' : selectedVersion.size > 1024 * 1024 ? 'Preview exceeds 1 MiB' : '';
}
function contentPath(version, preview = false) {
  return `/v1/admin/files/${encodeURIComponent(version.id)}/content?revision=${version.revision}${preview ? '&preview=true' : ''}`;
}
window.addEventListener('hashchange', () => { if (authenticated) showPage(location.hash.slice(1), true); });
$('refresh').addEventListener('click', () => { message(''); void refreshData().catch(showError); });
$('device-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (mutating || refreshing || !$('new-credential').hidden) return;
  const name = $('device-name').value.trim();
  if (!name) return;
  const currentSession = session;
  mutating = true; updateControls(); message('');
  try {
    const device = await api('/v1/devices', {method: 'POST', body: {name}});
    $('created-token').value = device.token; $('new-credential').hidden = false;
    $('device-name').value = ''; $('copy-token').textContent = 'Copy token';
    message(`Created a credential for ${device.name}. `);
    mutating = false; updateControls();
    await refreshData();
  } catch (error) { showError(error); }
  finally { if (currentSession === session) { mutating = false; updateControls(); } }
});
$('copy-token').addEventListener('click', async () => {
  const currentSession = session;
  const value = $('created-token').value;
  if (!value) return;
  $('created-token').focus(); $('created-token').select();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (currentSession === session && $('created-token').value === value) $('copy-token').textContent = 'Copied';
  } catch {
    if (currentSession === session && $('created-token').value === value) $('copy-token').textContent = 'Selected';
  }
});
$('dismiss-token').addEventListener('click', () => {
  $('created-token').value = ''; $('new-credential').hidden = true; updateControls(); $('device-name').focus();
});
function openRename(device) {
  if (mutating || refreshing) return;
  renameTarget = device;
  $('rename-name').value = device.name; $('rename-error').hidden = true;
  $('rename-dialog').showModal(); $('rename-name').focus(); $('rename-name').select();
}
$('rename-dialog').addEventListener('cancel', event => { if (mutating) event.preventDefault(); });
$('confirm-rename').addEventListener('click', async () => {
  if (!renameTarget || mutating) return;
  const name = $('rename-name').value.trim();
  if (!name) { $('rename-error').textContent = 'Enter a device name.'; $('rename-error').hidden = false; return; }
  const currentSession = session, device = renameTarget;
  mutating = true; updateControls();
  try {
    await api(`/v1/devices/${encodeURIComponent(device.id)}`, {method: 'PATCH', body: {name}});
    $('rename-dialog').close(); renameTarget = undefined;
    message(`Renamed ${device.name} to ${name}.`);
    mutating = false; updateControls();
    await refreshData();
  } catch (error) {
    if (currentSession === session && error.name !== 'AbortError') {
      if ($('rename-dialog').open) { $('rename-error').textContent = error.message; $('rename-error').hidden = false; }
      else showError(error);
    }
  } finally { if (currentSession === session) { mutating = false; updateControls(); } }
});
let revokeTarget, renameTarget, restoreTarget;
function openRevoke(device) {
  if (mutating || refreshing) return;
  revokeTarget = device;
  $('revoke-name').textContent = device.name; $('revoke-error').hidden = true;
  $('revoke-dialog').showModal(); $('cancel-revoke').focus();
}
$('revoke-dialog').addEventListener('cancel', event => { if (mutating) event.preventDefault(); });
$('confirm-revoke').addEventListener('click', async () => {
  if (!revokeTarget || mutating) return;
  const currentSession = session, device = revokeTarget;
  mutating = true; updateControls();
  try {
    await api(`/v1/devices/${encodeURIComponent(device.id)}`, {method: 'DELETE'});
    $('revoke-dialog').close(); revokeTarget = undefined;
    message(`Access revoked for ${device.name}.`);
    mutating = false; updateControls();
    await refreshData();
  } catch (error) {
    if (currentSession === session && error.name !== 'AbortError') {
      if ($('revoke-dialog').open) { $('revoke-error').textContent = error.message; $('revoke-error').hidden = false; }
      else showError(error);
    }
  } finally { if (currentSession === session) { mutating = false; updateControls(); } }
});
for (const id of ['file-search', 'show-deleted']) $(id).addEventListener(id === 'file-search' ? 'input' : 'change', () => { $('file-list').scrollTop = 0; renderFiles(); });
$('file-version').addEventListener('change', chooseVersion);
$('preview-file').addEventListener('click', async () => {
  if (!selectedVersion || $('preview-file').disabled) return;
  const generation = ++detailGeneration, version = selectedVersion;
  $('preview-file').disabled = true; $('file-preview').hidden = true;
  $('file-message').textContent = 'Loading…';
  try {
    const bytes = await api(contentPath(version, true), {bytes: true});
    if (generation !== detailGeneration) return;
    let text;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('Binary content');
    } catch { throw new Error('Not a UTF-8 text file'); }
    $('file-preview').textContent = text; $('file-preview').hidden = false;
    $('file-message').textContent = bytes.byteLength ? `Revision ${version.revision}` : 'Empty file';
  } catch (error) {
    if (generation === detailGeneration && error.name !== 'AbortError') $('file-message').textContent = error.message;
  } finally { if (generation === detailGeneration) $('preview-file').disabled = false; }
});
$('download-file').addEventListener('click', async () => {
  if (!selectedVersion || $('download-file').disabled) return;
  const version = selectedVersion, generation = detailGeneration;
  $('download-file').disabled = true; $('file-message').textContent = 'Preparing download…';
  try {
    const bytes = await api(contentPath(version), {bytes: true});
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'}));
    const link = element('a'); link.href = url; link.download = version.path.split('/').pop();
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (generation === detailGeneration) $('file-message').textContent = 'Download ready.';
  } catch (error) {
    if (generation === detailGeneration && error.name !== 'AbortError') $('file-message').textContent = error.message;
  } finally { if (generation === detailGeneration) $('download-file').disabled = false; }
});
showPage(location.hash.slice(1));

$('restore-file').addEventListener('click', () => {
  if (mutating || refreshing || $('restore-file').disabled || !selectedFile || !selectedVersion) return;
  restoreTarget = {file: selectedFile, version: selectedVersion};
  $('restore-name').textContent = `${selectedFile.path} · revision ${selectedVersion.revision} · ${formatBytes(selectedVersion.size)}`;
  $('restore-error').hidden = true;
  $('restore-dialog').showModal(); $('cancel-restore').focus();
});
$('restore-dialog').addEventListener('cancel', event => { if (mutating) event.preventDefault(); });
$('confirm-restore').addEventListener('click', async () => {
  if (!restoreTarget || mutating) return;
  const currentSession = session, {file, version} = restoreTarget;
  mutating = true; updateControls();
  try {
    await api(`/v1/admin/files/${encodeURIComponent(file.id)}/restore`, {method: 'POST', body: {revision: version.revision}});
    $('restore-dialog').close(); restoreTarget = undefined;
    message(`Restored revision ${version.revision} of ${file.path} as the new revision.`);
    mutating = false; updateControls();
    await refreshData();
  } catch (error) {
    if (currentSession === session && error.name !== 'AbortError') {
      if ($('restore-dialog').open) { $('restore-error').textContent = error.message; $('restore-error').hidden = false; }
      else showError(error);
    }
  } finally { if (currentSession === session) { mutating = false; updateControls(); } }
});
$('gc-preview').addEventListener('click', async () => {
  if (mutating || refreshing) return;
  mutating = true; updateControls(); collectionMessage('');
  try {
    const result = await api('/v1/maintenance/gc', {method: 'POST', body: {dry_run: true}});
    gcChecked = {objects: result.objects, bytes: result.bytes};
    collectionStorage = result.storage_bytes;
    collectionGrace = result.grace_seconds;
    collectionMessage(result.objects ? `${gcCount(result.objects)} can be collected.` : 'No unreferenced objects are eligible.');
  } catch (error) { showError(error); }
  finally { mutating = false; updateControls(); }
});
$('gc-apply').addEventListener('click', () => {
  if (mutating || refreshing || !gcChecked?.objects) return;
  $('gc-confirm').textContent = `${gcCount(gcChecked.objects)} (${formatBytes(gcChecked.bytes)}) older than the grace period will be removed. Retained revisions and current files are never removed.`;
  $('gc-error').hidden = true;
  $('gc-dialog').showModal(); $('cancel-gc').focus();
});
$('gc-dialog').addEventListener('cancel', event => { if (mutating) event.preventDefault(); });
$('confirm-gc').addEventListener('click', async () => {
  if (mutating) return;
  const currentSession = session;
  mutating = true; updateControls(); collectionMessage('');
  try {
    const result = await api('/v1/maintenance/gc', {method: 'POST', body: {dry_run: false}});
    $('gc-dialog').close();
    gcChecked = {objects: 0, bytes: 0};
    collectionStorage = result.storage_bytes;
    collectionMessage(result.objects ? `Collected ${gcCount(result.objects)} (${formatBytes(result.bytes)}).` : 'Nothing was eligible to collect.');
    mutating = false; updateControls();
    await refreshData();
  } catch (error) {
    if (currentSession === session && error.name !== 'AbortError') {
      if ($('gc-dialog').open) { $('gc-error').textContent = error.message; $('gc-error').hidden = false; }
      else showError(error);
    }
  } finally { if (currentSession === session) { mutating = false; updateControls(); } }
});

$('copy-server').addEventListener('click', async () => {
  const value = $('settings-server').textContent, currentSession = session;
  if (!authenticated || value === '—') return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (currentSession === session) $('copy-server').textContent = 'Copied';
  } catch {
    if (currentSession !== session) return;
    const range = document.createRange(); range.selectNodeContents($('settings-server'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    $('copy-server').textContent = 'Selected';
  }
});
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
let theme = 'system';
try { theme = localStorage.getItem('mindsync-theme') || 'system'; } catch { /* Preferences may be unavailable. */ }
if (!['system', 'light', 'dark'].includes(theme)) theme = 'system';
function applyTheme() {
  document.documentElement.dataset.theme = theme === 'system' ? (colorScheme.matches ? 'dark' : 'light') : theme;
  $('theme').value = theme;
  for (const button of document.querySelectorAll('[data-theme-value]')) {
    const active = button.dataset.themeValue === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
function setTheme(value) {
  theme = ['system', 'light', 'dark'].includes(value) ? value : 'system';
  try {
    if (theme === 'system') localStorage.removeItem('mindsync-theme');
    else localStorage.setItem('mindsync-theme', theme);
  } catch { /* Theme changes still work for the current tab. */ }
  applyTheme();
}
$('theme').addEventListener('change', () => setTheme($('theme').value));
for (const button of document.querySelectorAll('[data-theme-value]')) button.addEventListener('click', () => setTheme(button.dataset.themeValue));
colorScheme.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
applyTheme();
let authMode = 'login', challengeId = '', challengeEmail = '', authBusy = false, mailAvailable = false, registrationAvailable = false;
let resendAt = 0, cooldownTimer;
const authLabels = {login:'Sign in', register:'Create account', reset:'Send reset code', 'reset-complete':'Reset password'};
const passwordRules = value => ({length: [...value].length >= 12 && [...value].length <= 128, lower: /[a-z]/.test(value), upper: /[A-Z]/.test(value), number: /[0-9]/.test(value), symbol: /[!-/:-@[-`{-~]/.test(value)});
function authStatus(text = '') { $('auth-status').textContent = text; $('auth-status').hidden = !text; }
function setAuthMode(mode) {
  authMode = mode; challengeId = ''; challengeEmail = '';
  const registering = mode === 'register', newPassword = registering || mode === 'reset-complete';
  $('login-title').textContent = ({login:'Sign in',register:'Create account',reset:'Reset password','reset-complete':'Set a new password'})[mode];
  $('password-field').hidden = mode === 'reset'; $('admin-password').required = mode !== 'reset';
  $('admin-password').autocomplete = newPassword ? 'new-password' : 'current-password';
  $('confirmation-field').hidden = !newPassword; $('confirm-password').required = newPassword;
  $('password-checklist').hidden = !newPassword;
  if(newPassword)$('admin-password').setAttribute('aria-describedby','password-checklist');else $('admin-password').removeAttribute('aria-describedby');
  $('code-field').hidden = !newPassword; $('verification-code').required = newPassword;
  $('send-registration-code').hidden = !registering;
  $('admin-email').readOnly = mode === 'reset-complete';
  $('forgot-password').hidden = mode !== 'login';
  $('register-account').hidden = mode !== 'login'; $('back-to-login').hidden = mode === 'login';
  $('account-prompt').textContent = mode === 'login' ? "Don't have an account?" : 'Back to';
  $('resend-code').hidden = mode !== 'reset-complete';
  $('sign-in').textContent = authLabels[mode];
  $('login-error').hidden = true; authStatus();
  $('admin-password').value = ''; $('admin-password').type = 'password';
  $('show-password').textContent = 'Show'; $('show-password').setAttribute('aria-pressed','false'); $('show-password').setAttribute('aria-label','Show password');
  $('confirm-password').value = ''; $('verification-code').value = '';
  updatePasswordChecks(); updateAuthControls();
}
function updateAuthControls() {
  const wait = Math.max(0,Math.ceil((resendAt-Date.now())/1000));
  $('sign-in').disabled = authBusy || (authMode !== 'login' && (!mailAvailable || (authMode === 'register' && !registrationAvailable)));
  $('send-registration-code').disabled = authBusy || !mailAvailable || !registrationAvailable || wait > 0;
  $('send-registration-code').textContent = wait ? `Resend in ${wait}s` : challengeId ? 'Resend code' : 'Send code';
  $('resend-code').disabled = authBusy || wait > 0;
  $('resend-code').textContent = wait ? `Resend in ${wait}s` : 'Resend code';
  if (wait && !cooldownTimer) cooldownTimer = setInterval(()=>{updateAuthControls();if(Date.now()>=resendAt){clearInterval(cooldownTimer);cooldownTimer=undefined;}},1000);
}
function updatePasswordChecks() {
  const rules = passwordRules($('admin-password').value);
  for (const node of $('password-checklist').children) {
    const valid = rules[node.dataset.rule]; node.dataset.valid = String(valid);
    node.setAttribute('aria-label', `${node.textContent}: ${valid ? 'met' : 'not met'}`);
  }
}
function authError(error) { if (error.name !== 'AbortError') { $('login-error').textContent = error.message; $('login-error').hidden = false; } }
async function enterWorkspace(info) {
  csrfToken = info.csrf_token; authenticated = true;
  $('admin-email').value = info.email || $('admin-email').value;
  $('account-email').textContent = $('admin-email').value;
  for (const id of ['admin-password','confirm-password','verification-code']) $(id).value = '';
  $('login').hidden = true; $('workspace').hidden = false;
  showPage(location.hash.slice(1), true); await refreshData();
}
async function sendCode(registering) {
  const address = $('admin-email').value;
  const response = await api(`/v1/auth/${registering ? 'register' : 'password/reset'}/send`,{method:'POST',body:{email:address}});
  if (!registering && authMode !== 'reset-complete') setAuthMode('reset-complete');
  challengeId = response.challenge_id; challengeEmail = address;
  resendAt = Date.now() + response.retry_after * 1000;
  authStatus(response.message); updateAuthControls(); $('verification-code').focus();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (authBusy || $('sign-in').disabled) return;
  authBusy = true; updateAuthControls(); $('login-error').hidden = true;
  const mode = authMode, generation = session;
  $('sign-in').textContent = mode === 'login' ? 'Signing in…' : mode === 'reset' ? 'Sending…' : 'Saving…';
  try {
    if (mode === 'login') {
      const info = await api('/v1/auth/login',{method:'POST',body:{email:$('admin-email').value,password:$('admin-password').value}});
      if (generation === session) await enterWorkspace(info);
    } else if (mode === 'reset') {
      await sendCode(false);
    } else {
      const password = $('admin-password').value;
      if (!Object.values(passwordRules(password)).every(Boolean)) throw new Error('Meet all password requirements before continuing.');
      if (password !== $('confirm-password').value) throw new Error('Passwords do not match.');
      if (!challengeId || challengeEmail !== $('admin-email').value) throw new Error('Send a verification code to your email first.');
      await api(`/v1/auth/${mode === 'register' ? 'register' : 'password/reset'}/complete`,{method:'POST',body:{email:challengeEmail,challenge_id:challengeId,code:$('verification-code').value,password,confirmation:$('confirm-password').value}});
      registrationAvailable = false; setAuthMode('login');
      authStatus(mode === 'register' ? 'Account created. Sign in to continue.' : 'Password reset. Sign in with your new password.');
      $('admin-password').focus();
    }
  } catch(error) { if (generation === session) authError(error); }
  finally { authBusy = false; $('sign-in').textContent = authLabels[authMode]; updateAuthControls(); }
});
$('admin-password').addEventListener('input',updatePasswordChecks);
$('admin-email').addEventListener('input',()=>{ if (challengeId && challengeEmail !== $('admin-email').value) {challengeId = ''; $('verification-code').value = ''; updateAuthControls();} });
$('show-password').addEventListener('click',()=>{
  const show = $('admin-password').type === 'password'; $('admin-password').type = show ? 'text' : 'password';
  $('show-password').textContent = show ? 'Hide' : 'Show'; $('show-password').setAttribute('aria-label',show ? 'Hide password' : 'Show password'); $('show-password').setAttribute('aria-pressed',String(show));
});
$('forgot-password').addEventListener('click',()=>{ if (!authBusy) {setAuthMode('reset'); if(!mailAvailable)authStatus('Email recovery is currently unavailable. Please try again later.');} });
$('register-account').addEventListener('click',()=>{ if (!authBusy) {setAuthMode('register'); if(!registrationAvailable || !mailAvailable)authStatus('Account creation is currently unavailable.');} });
$('back-to-login').addEventListener('click',()=>{ if (!authBusy) setAuthMode('login'); });
$('send-registration-code').addEventListener('click',async()=>{
  if(authBusy || !$('admin-email').reportValidity())return;
  authBusy = true; updateAuthControls(); $('login-error').hidden = true; $('send-registration-code').textContent = 'Sending…';
  try{await sendCode(true);}catch(error){authError(error);}finally{authBusy=false;updateAuthControls();}
});
$('resend-code').addEventListener('click',async()=>{
  if(authBusy || Date.now()<resendAt)return;
  authBusy=true;updateAuthControls();try{await sendCode(false);}catch(error){authError(error);}finally{authBusy=false;updateAuthControls();}
});
$('sign-out').addEventListener('click',async()=>{
  $('sign-out').disabled=true;
  try{await api('/v1/auth/logout',{method:'POST'});resetSession();setAuthMode('login');}
  catch(error){showError(error);}finally{$('sign-out').disabled=false;}
});
$('change-password-form').addEventListener('submit',async event=>{
  event.preventDefault(); if ($('change-password').disabled) return;
  const password = $('new-password').value;
  if (!Object.values(passwordRules(password)).every(Boolean)) { message('Use 12–128 characters including lowercase, uppercase, a number, and a special character.',true); return; }
  if (password !== $('new-password-confirmation').value) { message('Passwords do not match.',true); return; }
  $('change-password').disabled = true;
  try {
    await api('/v1/auth/password/change',{method:'POST',body:{current_password:$('current-password').value,password,confirmation:$('new-password-confirmation').value}});
    resetSession(); setAuthMode('login'); authStatus('Password changed. Sign in again.');
  } catch(error) { showError(error); } finally { $('change-password').disabled = false; }
});
async function initializeAuth() {
  $('sign-in').disabled = true;
  try {
    const status = await api('/v1/auth/status');
    mailAvailable = status.email_available; registrationAvailable = status.registration_available;
    setAuthMode('login');
    if (status.initialized) {
      try { const info = await api('/v1/auth/session'); await enterWorkspace(info); }
      catch(error) { if(authenticated)showError(error); }
    }
  } catch(error) { authError(error); }
}
void initializeAuth();
