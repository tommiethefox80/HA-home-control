// Keeps the dashboard card up to date by itself.
//
// On every start the app copies its card into the www folder of Home Assistant's config folder
// (which Home Assistant serves as /local/…) and points the dashboard resource at this version
// (/local/home-control-card.js?v=1.3.0), adding the resource if there isn't one. So a new card
// arrives with every update of the app, and browsers fetch it fresh, with nothing to copy or edit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CARD_NAME = 'home-control-card.js';

/** This app's slug, from the container's hostname (the Supervisor names it after the slug). */
export function selfSlug() {
  if (process.env.APP_SLUG) return process.env.APP_SLUG;
  if (!process.env.SUPERVISOR_TOKEN || process.env.HA_URL) return null;
  const h = os.hostname();
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(h) ? h.replace(/-/g, '_') : null;
}

/** Where this app's panel is in Home Assistant, e.g. /a1b2c3d4_home_control. */
export function panelPath() {
  if (process.env.PANEL_PATH) return process.env.PANEL_PATH;
  const slug = selfSlug();
  return slug ? `/${slug}` : null;
}

const pathOf = (url) => String(url || '').replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];

export function createCardInstaller({ client, log, version, source, configDir }) {
  const status = { file: null, resource: null, url: null, restartNeeded: false, error: null };
  let resourceDone = false;

  function copy() {
    if (!configDir || !fs.existsSync(configDir)) { status.file = 'no-access'; return; }
    const www = path.join(configDir, 'www');
    const had = fs.existsSync(www);
    try {
      const code = fs.readFileSync(source);
      fs.mkdirSync(www, { recursive: true });
      const dest = path.join(www, CARD_NAME);
      let same = false;
      try { same = fs.readFileSync(dest).equals(code); } catch { /* not there yet */ }
      if (!same) {
        const tmp = `${dest}.tmp`;
        fs.writeFileSync(tmp, code);
        fs.renameSync(tmp, dest);
        log.info?.(`Dashboard card ${version} copied to www/${CARD_NAME}`);
      }
      status.file = same ? 'current' : 'written';
      // Home Assistant only serves /local/ if the www folder was there when it started
      if (!had) status.restartNeeded = true;
    } catch (err) {
      status.file = 'failed';
      status.error = err.message;
      log.warn?.(`Couldn't copy the dashboard card into Home Assistant's www folder: ${err.message}`);
    }
  }

  async function resource() {
    if (resourceDone || !client.connected) return;
    if (!['written', 'current'].includes(status.file)) return; // don't point dashboards at a card that isn't there
    const url = `/local/${CARD_NAME}?v=${version}`;
    status.url = url;
    try {
      const list = await client.send('lovelace/resources');
      const ours = (list || []).filter((r) => pathOf(r.url).endsWith(`/${CARD_NAME}`));
      if (!ours.length) {
        await client.send('lovelace/resources/create', { res_type: 'module', url });
        status.resource = 'added';
        log.info?.(`Dashboard card added to your dashboards' resources (${url})`);
      } else {
        let changed = 0;
        for (const r of ours) {
          if (r.url === url && (r.type || r.res_type) === 'module') continue;
          await client.send('lovelace/resources/update', { resource_id: r.id, res_type: 'module', url });
          changed++;
        }
        status.resource = changed ? 'updated' : 'current';
        if (changed) log.info?.(`Dashboard card resource now ${url}`);
      }
      resourceDone = true;
    } catch (err) {
      // dashboards in YAML mode keep their resources in configuration.yaml, which the app can't change
      if (err.code === 'unknown_command') {
        status.resource = 'yaml';
        resourceDone = true;
        log.info?.(`Your dashboards' resources are set in YAML: point the card's resource at ${url}`);
      } else {
        status.resource = 'failed';
        status.error = err.message;
        log.warn?.(`Couldn't update the dashboard card's resource: ${err.message}`);
      }
    }
  }

  function start() {
    copy();
    client.on('ready', () => { setTimeout(() => { resource(); }, 2000); });
    if (client.connected) resource();
  }

  return { start, status, resource };
}
