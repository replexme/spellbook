/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { presentationReferenceEpoch, installPresentationReferenceDate } from './presentation-render-clock.mjs';

test('reference time is explicit UTC, optional and a real calendar date', () => {
  assert.equal(presentationReferenceEpoch(), null);
  assert.equal(presentationReferenceEpoch('2026-10-08T08:02:37Z'), Date.parse('2026-10-08T08:02:37Z'));
  for(const date of ['2026-02-30T00:00:00Z','2026-10-08','2026-10-08T08:02:37+09:00',0])
    assert.throws(() => presentationReferenceEpoch(date), /reference_date_time_invalid/);
});

test('real browser reference fields use the selected date and timezone while timers advance', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({timezoneId:'Asia/Seoul'});
    const epoch = presentationReferenceEpoch('2026-10-08T23:59:59Z');
    await context.addInitScript(installPresentationReferenceDate,epoch);
    const page = await context.newPage();
    await page.goto('data:text/html,<iframe src="data:text/html,child"></iframe>');
    for(const frame of page.frames()) {
      const result = await frame.evaluate(async () => {
        const before=Date.now(), perf=performance.now();
        await new Promise(resolve => setTimeout(resolve,25));
        return {iso:new Date().toISOString(),day:new Date().getDate(),hour:new Date().getHours(),explicit:new Date(0).toISOString(),instance:new Date() instanceof Date,parsed:Date.parse('1970-01-01T00:00:00Z'),nowAdvanced:Date.now()>before,performanceAdvanced:performance.now()>perf,zone:Intl.DateTimeFormat().resolvedOptions().timeZone};
      });
      assert.deepEqual(result,{iso:'2026-10-08T23:59:59.000Z',day:9,hour:8,explicit:'1970-01-01T00:00:00.000Z',instance:true,parsed:0,nowAdvanced:true,performanceAdvanced:true,zone:'Asia/Seoul'});
    }
    await context.close();
    const live = await browser.newContext({timezoneId:'Asia/Seoul'});
    const livePage = await live.newPage();
    const liveTime = await livePage.evaluate(() => ({date:new Date().getTime(),now:Date.now()}));
    assert.ok(Math.abs(liveTime.date-liveTime.now)<1000);
    assert.ok(Math.abs(liveTime.date-Date.now())<1000);
    await live.close();
  } finally { await browser.close(); }
});
