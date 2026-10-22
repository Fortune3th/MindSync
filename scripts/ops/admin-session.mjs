// Authenticate once and keep a short-lived session in process memory only.
export async function adminSession(base) {
  const address = new URL(base);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('Invalid server URL.');
  const existing = process.env.MINDSYNC_ADMIN_SESSION;
  if (existing) return existing;
  const email = process.env.MINDSYNC_ADMIN_EMAIL, password = process.env.MINDSYNC_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set MINDSYNC_ADMIN_EMAIL and MINDSYNC_ADMIN_PASSWORD, or MINDSYNC_ADMIN_SESSION.');
  const response = await fetch(`${base.replace(/\/+$/, '')}/v1/auth/login`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password,cli:true}), redirect:'error',signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Administrator sign-in failed (${response.status}).`);
  const token = (await response.json()).session_token;
  if (!token) throw new Error('The server did not issue an administrator session.');
  return token;
}
export async function closeAdminSession(base, token) {
  if (process.env.MINDSYNC_ADMIN_SESSION) return;
  const response = await fetch(`${base.replace(/\/+$/, '')}/v1/auth/logout`,{method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('The temporary administrator session could not be closed; it will expire automatically.');
}
