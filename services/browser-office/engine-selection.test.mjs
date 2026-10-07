/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {configuredBrowserEngine, selection, admitSelectedOnlyOffice} from './engine-selection.mjs';
test('ONLYOFFICE is the default; rollback is explicit and invalid engines fail closed',()=>{
 assert.equal(configuredBrowserEngine({}), 'onlyoffice');
 assert.equal(configuredBrowserEngine({SPELLBOOK_BROWSER_ENGINE:'libreoffice'}),'libreoffice');
 assert.throws(()=>configuredBrowserEngine({SPELLBOOK_BROWSER_ENGINE:'typo'}),/invalid/);
 assert.equal(selection.onlyoffice.publicReleaseAdmitted,true);
 assert.match(selection.libreoffice.rollbackCommit,/^[a-f0-9]{40}$/);
});
test('missing selected distribution fails rather than booting LibreOffice',async()=>{
 await assert.rejects(admitSelectedOnlyOffice('/nonexistent-spellbook-release'),/ENOENT/);
});
