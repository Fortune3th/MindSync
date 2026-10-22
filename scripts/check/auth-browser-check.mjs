// Exercise real email registration and recovery only on a disposable local service.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const base = process.env.MINDSYNC_BROWSER_URL || 'http://127.0.0.1:18090';
const inbox = process.env.MINDSYNC_TEST_INBOX || 'http://127.0.0.1:18026';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname) || ['5173','18089'].includes(new URL(base).port) || process.env.MINDSYNC_ADMIN_BROWSER_TEST !== '1' || !['127.0.0.1','localhost'].includes(new URL(inbox).hostname)) throw new Error('Use a separate disposable loopback server and test inbox, with MINDSYNC_ADMIN_BROWSER_TEST=1.');
const {chromium} = await import(process.env.MINDSYNC_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,...(process.env.MINDSYNC_BROWSER_EXECUTABLE ? {executablePath:process.env.MINDSYNC_BROWSER_EXECUTABLE} : {})});
const output = process.env.MINDSYNC_BROWSER_OUTPUT || '/private/tmp/mindsync-auth-browser-check';
await mkdir(output,{recursive:true});
const context = await browser.newContext({viewport:{width:375,height:812}});
const page = await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const email='browser-owner@example.com', password='Browser Password1!',replacement='Browser Password2$';
async function code() {
  const list=await (await fetch(`${inbox}/api/v1/messages`)).json();
  const message=list.messages.find(message=>message.Subject==='MindSync verification code');assert.ok(message,'A verification message arrived in the local SMTP inbox');
  const content=await (await fetch(`${inbox}/api/v1/message/${message.ID}`)).json();
  return content.Text.match(/code is: (\d{6})/)[1];
}
const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
try {
  await page.goto(base);
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await page.locator('#admin-password').isVisible(),true);
  assert.equal(await page.locator('#password-checklist').isVisible(),false);
  assert.equal(await page.locator('body').innerText().then(text=>/token|setup credential|NAS|environment file/i.test(text)),false);
  assert.equal(await page.locator('label[for="admin-password"]').textContent(),'Password');
  await page.screenshot({path:join(output,'login-mobile.png'),fullPage:true});
  await page.locator('#register-account').click();await page.getByRole('heading',{name:'Create account',exact:true}).waitFor();
  await page.locator('#admin-email').fill(email);
  await page.locator('#admin-password').fill('weak');
  assert.equal(await page.locator('#password-checklist li[data-valid="true"]').count(),1);
  await page.locator('#admin-password').fill(password);await page.locator('#confirm-password').fill(password);
  assert.equal(await page.locator('#password-checklist li[data-valid="true"]').count(),5);
  await page.locator('#show-password').click();assert.equal(await page.locator('#admin-password').getAttribute('type'),'text');
  await page.locator('#show-password').click();
  const setupSentAt=Date.now();
  await page.locator('#send-registration-code').click();
  await page.locator('#auth-status').filter({hasText:'verification code has been sent'}).waitFor();
  await page.locator('#verification-code').fill(await code());
  await noOverflow();await page.screenshot({path:join(output,'registration-mobile.png'),fullPage:true});
  await page.locator('#sign-in').click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  await page.locator('#admin-password').fill(password);await page.locator('#sign-in').click();await page.locator('#workspace').waitFor();
  await page.reload();await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#admin-email').inputValue(),email,'Session restoration keeps the owner email available for recovery.');
  assert.equal(await page.evaluate(()=>document.cookie.includes('mindsync_session')),false);
  const cookie=(await context.cookies()).find(cookie=>cookie.name.startsWith('mindsync_session_'));assert.ok(cookie.httpOnly);assert.equal(cookie.sameSite,'Strict');
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.locator('#sign-out').click();await page.locator('#login').waitFor();
  await page.locator('#forgot-password').click();await page.getByRole('heading',{name:'Reset password',exact:true}).waitFor();
  // A per-address send budget is shared by registration and recovery.
  while (Date.now()-setupSentAt<61000) await new Promise(resolve=>setTimeout(resolve,1000));
  await page.locator('#sign-in').click();await page.getByRole('heading',{name:'Set a new password',exact:true}).waitFor({timeout:25000});
  await page.locator('#verification-code').fill(await code());await page.locator('#admin-password').fill(replacement);await page.locator('#confirm-password').fill(replacement);
  await noOverflow();await page.screenshot({path:join(output,'reset-mobile.png'),fullPage:true});await page.locator('#sign-in').click();
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await page.locator('#admin-password').fill(password);await page.locator('#sign-in').click();
  await page.locator('#login-error').filter({hasText:'Invalid email, password, or session'}).waitFor();
  await page.locator('#admin-password').fill(replacement);await page.locator('#sign-in').click();await page.locator('#workspace').waitFor();
  await page.locator('[data-page="settings"]').click();await page.locator('#account-email').filter({hasText:email}).waitFor();
  await page.locator('#current-password').fill(replacement);await page.locator('#new-password').fill(password);await page.locator('#new-password-confirmation').fill(password);await page.locator('#change-password').click();
  await page.locator('#login').waitFor();await page.locator('#auth-status').filter({hasText:'Password changed'}).waitFor();
  await page.setViewportSize({width:1440,height:1000});await noOverflow();await page.screenshot({path:join(output,'login-desktop.png'),fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:320,height:700});await noOverflow();await page.screenshot({path:join(output,'login-dark-320.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['owner registration with real SMTP capture','standard sign-in without setup credentials','live password checklist','password visibility','one-time code','cookie session restoration','HttpOnly cookie','no persistent passwords','email reset','old password rejection','authenticated password change','desktop/mobile/dark layouts'],screenshots:output},null,2));
} catch(error) { console.error({heading:await page.locator('#login-title').textContent(),error:await page.locator('#login-error').textContent(),emailValid:await page.locator('#admin-email').evaluate(node=>node.checkValidity())});await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error; } finally {await browser.close();}
