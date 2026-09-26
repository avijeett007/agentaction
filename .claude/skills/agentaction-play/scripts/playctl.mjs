#!/usr/bin/env node
/**
 * playctl — read and write the AgentAction Google Play listing from the CLI.
 *
 *   node playctl.mjs doctor                 can we reach Play at all, and with what rights
 *   node playctl.mjs tracks                 every track, its releases and their status
 *   node playctl.mjs listing                title, descriptions, and how many images are live
 *   node playctl.mjs drafts                 draft releases left lying around
 *   node playctl.mjs discard <track>        remove the draft release on a track
 *   node playctl.mjs promote <from> <to>    move a release between tracks
 *
 * WHY THIS EXISTS: the Play Console UI reports "Verified" for things that are not
 * working, and `eas` only speaks about submissions. Reading the API is the only
 * way to know what Play actually holds. `doctor` in particular answers the
 * question that wasted the most time: the difference between "the key is wrong",
 * "the API is not enabled" and "the service account was never invited" — three
 * problems that all present as a 403.
 *
 * CREDENTIAL: ~/.config/agentaction/play-service-account.json, outside every
 * checkout. Override with PLAY_SERVICE_ACCOUNT_KEY. Never commit the key; the
 * repo's publish guard now refuses any JSON containing a service-account marker.
 */

import { google } from 'googleapis';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const PKG = process.env.PLAY_PACKAGE_NAME || 'pro.knotie.agentaction';
const KEY =
  process.env.PLAY_SERVICE_ACCOUNT_KEY ||
  join(homedir(), '.config', 'agentaction', 'play-service-account.json');

const [, , command, ...args] = process.argv;

function die(message) {
  console.error(`playctl: ${message}`);
  process.exit(1);
}

async function client() {
  if (!existsSync(KEY)) {
    die(`no service-account key at ${KEY}\n` +
        `  Create one: Google Cloud → IAM & Admin → Service Accounts → Manage keys → JSON,\n` +
        `  then invite its email into Play Console → Users and permissions.`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  return google.androidpublisher({ version: 'v3', auth: await auth.getClient() });
}

/** Every call needs an edit; every edit must be cleaned up or it lingers. */
async function withEdit(fn, { commit = false } = {}) {
  const ap = await client();
  const { data } = await ap.edits.insert({ packageName: PKG });
  const editId = data.id;
  try {
    const result = await fn(ap, editId);
    if (commit) await ap.edits.commit({ packageName: PKG, editId });
    else await ap.edits.delete({ packageName: PKG, editId });
    return result;
  } catch (error) {
    await ap.edits.delete({ packageName: PKG, editId }).catch(() => {});
    throw error;
  }
}

function explain(error) {
  const message = error?.errors?.[0]?.message || error?.message || String(error);
  const code = error?.code || error?.status;
  if (code === 403) {
    return `403 ${message}\n` +
      `  Three different problems look like this:\n` +
      `   1. the service account was never invited in Play Console → Users and permissions\n` +
      `   2. the invite is still pending rather than active\n` +
      `   3. the app does not exist under package ${PKG}\n` +
      `  A DISABLED API reads differently — it names the API and says SERVICE_DISABLED.`;
  }
  return `${code ?? ''} ${message}`.trim();
}

const commands = {
  async doctor() {
    console.log(`package: ${PKG}`);
    console.log(`key    : ${KEY}`);
    try {
      const edit = await withEdit(async (_ap, editId) => editId);
      console.log(`\nOK — key valid, API enabled, permissions granted (edit ${edit}).`);
    } catch (error) {
      console.log(`\nFAILED: ${explain(error)}`);
      process.exitCode = 1;
    }
  },

  async tracks() {
    const tracks = await withEdit(async (ap, editId) =>
      (await ap.edits.tracks.list({ packageName: PKG, editId })).data.tracks || []);
    for (const track of tracks) {
      const releases = track.releases || [];
      if (!releases.length) { console.log(`${track.track.padEnd(12)} (empty)`); continue; }
      for (const r of releases) {
        console.log(
          `${track.track.padEnd(12)} name=${r.name || '-'} status=${r.status} ` +
          `vc=${(r.versionCodes || []).join(',') || '-'}`);
      }
    }
  },

  async listing() {
    await withEdit(async (ap, editId) => {
      const l = (await ap.edits.listings.get({ packageName: PKG, editId, language: 'en-US' })).data;
      console.log(`title           : ${l.title || '(empty)'}`);
      console.log(`shortDescription: ${l.shortDescription || '(EMPTY)'}`);
      console.log(`fullDescription : ${l.fullDescription ? `${l.fullDescription.length} chars` : '(EMPTY)'}`);
      for (const kind of ['icon', 'featureGraphic', 'phoneScreenshots']) {
        const images = await ap.edits.images
          .list({ packageName: PKG, editId, language: 'en-US', imageType: kind })
          .catch(() => ({ data: {} }));
        console.log(`${kind.padEnd(16)}: ${(images.data.images || []).length} live`);
      }
    });
  },

  async drafts() {
    const tracks = await withEdit(async (ap, editId) =>
      (await ap.edits.tracks.list({ packageName: PKG, editId })).data.tracks || []);
    let found = 0;
    for (const track of tracks) {
      for (const r of track.releases || []) {
        if (r.status === 'draft') {
          found += 1;
          console.log(`${track.track.padEnd(12)} draft  name=${r.name || '(none)'} vc=${(r.versionCodes || []).join(',') || '(none)'}`);
        }
      }
    }
    if (!found) console.log('no draft releases');
    // A draft on an OPEN track matters: publishing it fixes the app signing key
    // choice permanently, which is a one-way door reached by a single click.
  },

  async discard(track) {
    if (!track) die('usage: discard <track>   (internal | alpha | beta | production)');
    await withEdit(async (ap, editId) => {
      const current = (await ap.edits.tracks.get({ packageName: PKG, editId, track })).data;
      const keep = (current.releases || []).filter((r) => r.status !== 'draft');
      const dropped = (current.releases || []).length - keep.length;
      if (!dropped) { console.log(`${track}: no draft to discard`); return; }
      await ap.edits.tracks.update({
        packageName: PKG, editId, track, requestBody: { track, releases: keep },
      });
      console.log(`${track}: discarded ${dropped} draft release(s)`);
    }, { commit: true });
  },

  async promote(from, to) {
    if (!from || !to) die('usage: promote <from-track> <to-track>');
    await withEdit(async (ap, editId) => {
      const source = (await ap.edits.tracks.get({ packageName: PKG, editId, track: from })).data;
      const live = (source.releases || []).find((r) => r.status === 'completed');
      if (!live) die(`${from} has no completed release to promote`);
      await ap.edits.tracks.update({
        packageName: PKG, editId, track: to,
        requestBody: { track: to, releases: [{ ...live, status: 'completed' }] },
      });
      console.log(`promoted ${(live.versionCodes || []).join(',')} from ${from} to ${to}`);
    }, { commit: true });
  },
};

const run = commands[command];
if (!run) {
  console.log('usage: playctl <doctor|tracks|listing|drafts|discard|promote> [args]');
  process.exit(command ? 1 : 0);
}
run(...args).catch((error) => {
  console.error(`playctl: ${explain(error)}`);
  process.exit(1);
});
