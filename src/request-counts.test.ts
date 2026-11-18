// Exact Google request counts through the real get_performance composition; all I/O and time are injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEANUP_MIN_INTERVAL_MS } from './integrations/bidmanager/cleanup.js';
import {
  advertiserId, checkRedaction, composition, fileUrl, googleError, ids, json, markers,
  page, query, queryId, report, reportId, title, token, type FakeRequest, type Step,
} from './composition-harness.test.js';

const partnerA = '987654321020', partnerB = '987654321021';
const campaignId = '987654321015', siblingId = '987654321016';
const campaignName = `${token} campaign`;
const advertiser = { advertiserId, displayName: title, partnerId: partnerA, entityStatus: 'ENTITY_STATUS_ACTIVE', currencyCode: 'USD', timeZone: 'Europe/Istanbul' };
const campaign = { advertiserId, campaignId, displayName: campaignName, entityStatus: 'ENTITY_STATUS_ACTIVE' };
const partners = '/v4/partners', advertisers = '/v4/advertisers';
const advertiserPath = `${advertisers}/${advertiserId}`, campaigns = `${advertiserPath}/campaigns`;
const campaignPath = `${campaigns}/${campaignId}`;
const queries = '/v2/queries', runPath = `${queries}/${queryId}:run`;
const reportPath = `${queries}/${queryId}/reports/${reportId}`;
const idArgs = { advertiserId, campaignId };
const nameArgs = { advertiserName: title, campaignName };
const running = { ...report, metadata: { status: { state: 'RUNNING' } } };
const ran: Step = { path: runPath, method: 'POST', respond: () => json(running) };
const cleanupList: Step = { path: queries, respond: () => json({ queries: [] }), check: url => {
  assert.equal(url.searchParams.get('pageSize'), '100');
  assert.equal(url.searchParams.get('orderBy'), 'queryId');
} };
const partnerList: Step = { path: partners, respond: () => json({ partners: [
  { partnerId: partnerA, displayName: title }, { partnerId: partnerB, displayName: token },
] }) };
const campaignList: Step = { path: campaigns, respond: () => json({ campaigns: [
  campaign, { ...campaign, campaignId: siblingId, displayName: `${campaignName} sibling` },
] }) };
type Harness = Awaited<ReturnType<typeof composition>>;
type Call = Awaited<ReturnType<Harness['call']>>;

const dv360 = (requests: readonly FakeRequest[]) => requests.filter(request => request.url.pathname.startsWith('/v4/'));
const bidManager = (requests: readonly FakeRequest[]) => requests.filter(request => request.url.pathname.startsWith('/v2/'));
const sequence = (requests: readonly FakeRequest[]) => requests.map(request => `${request.method} ${request.url.pathname}`);
const gets = (...paths: string[]) => paths.map(path => `GET ${path}`);
const reportSequence = (cleanup = true, checks = 1) => [
  `POST ${queries}`, `POST ${runPath}`, ...(cleanup ? gets(queries) : []), ...gets(...Array<string>(checks).fill(reportPath)),
];
function checkRequests(requests: readonly FakeRequest[], dv: readonly string[], bm: readonly string[]) {
  assert.equal(dv360(requests).length, dv.length);
  assert.equal(bidManager(requests).length, bm.length);
  assert.deepEqual(sequence(dv360(requests)), dv);
  assert.deepEqual(sequence(bidManager(requests)), bm);
}
function checkCall(h: Harness, call: Call, isError = false) {
  assert.equal(call.result.isError === true, isError);
  assert.equal(call.tool.tool, 'get_performance');
  checkRedaction(h.lines);
  for (const line of h.lines) for (const id of [partnerA, partnerB, campaignId, siblingId]) assert.ok(!line.includes(id));
  assert.equal(call.result.content.length, 1);
  const [block] = call.result.content as { type: string; text: string }[];
  assert.equal(block.type, 'text');
  return block.text;
}
function created(target: 'advertiser' | 'campaign' = 'campaign', preset: 'delivery' | 'youtube' = 'delivery'): Step {
  return { path: queries, method: 'POST', respond: () => json(query), check: (_url, body) => {
    const payload = JSON.parse(body!);
    assert.ok(payload.metadata.title.startsWith(`[MCP] get_performance ${preset} total `));
    for (const value of [...markers, ...ids, partnerA, partnerB, campaignId, siblingId]) assert.ok(!payload.metadata.title.includes(value));
    assert.equal(payload.params.type, preset === 'youtube' ? 'YOUTUBE' : 'STANDARD');
    assert.deepEqual(payload.params.filters, [
      { type: 'FILTER_ADVERTISER', value: advertiserId },
      ...(target === 'campaign' ? [{ type: 'FILTER_MEDIA_PLAN', value: campaignId }] : []),
      ...(preset === 'youtube' ? [{ type: 'FILTER_PARTNER', value: partnerA }] : []),
    ]);
  } };
}
function describe(h: Harness, target = true, advertiserResponse = () => json(advertiser)) {
  h.steps.push({ path: advertiserPath, respond: advertiserResponse });
  if (target) h.steps.push({ path: campaignPath, respond: () => json(campaign) });
}
function done(h: Harness, options: { cleanup?: boolean; target?: 'advertiser' | 'campaign'; preset?: 'delivery' | 'youtube' } = {}) {
  h.steps.push(created(options.target, options.preset), ran);
  if (options.cleanup !== false) h.steps.push(cleanupList);
  h.steps.push({ path: reportPath, respond: () => json(report) });
  h.readers.push(() => page);
}
function directories(h: Harness, failA = false, matchInB = false) {
  // Both steps dispatch by partnerId: the concurrent scans may reach fetch in either order.
  const respond = (url: URL) => {
    const partnerId = url.searchParams.get('partnerId');
    assert.ok(partnerId === partnerA || partnerId === partnerB);
    if (failA && partnerId === partnerA) return googleError(400);
    return json({ advertisers: partnerId === (matchInB ? partnerB : partnerA) ? [{ ...advertiser, partnerId }] : [] });
  };
  h.steps.push({ path: advertisers, respond }, { path: advertisers, respond });
}
function checkDirectories(requests: readonly FakeRequest[]) {
  assert.deepEqual(requests.filter(request => request.url.pathname === advertisers)
    .map(request => request.url.searchParams.get('partnerId')).sort(), [partnerA, partnerB]);
}
const header = `Performance of campaign ${campaignName} (${campaignId})`;

test('C-1 IDs: two metadata reads and four Bid Manager requests return a 50-row preview', async t => {
  const h = await composition(t);
  describe(h); done(h);
  const text = checkCall(h, await h.call('get_performance', idArgs));
  checkRequests(h.requests, gets(advertiserPath, campaignPath), reportSequence());
  assert.equal(text.split('\n')[0], header);
  assert.ok(text.includes(fileUrl));
  assert.deepEqual(h.reads, [{ url: fileUrl, limit: 50, offset: 0 }]);
});

test('C-2 cleanup is throttled at 30 minutes; default cleanup runs on both immediate calls', async t => {
  const h = await composition(t, { cleanupMinIntervalMs: CLEANUP_MIN_INTERVAL_MS });
  for (const [index, cleanup] of [true, false, true].entries()) {
    if (index === 2) h.advance(CLEANUP_MIN_INTERVAL_MS);
    const before = h.requests.length;
    describe(h); done(h, { cleanup });
    assert.equal(checkCall(h, await h.call('get_performance', idArgs)).split('\n')[0], header);
    checkRequests(h.requests.slice(before), gets(advertiserPath, campaignPath), reportSequence(cleanup));
  }
  const unthrottled = await composition(t);
  for (let index = 0; index < 2; index++) {
    const before = unthrottled.requests.length;
    describe(unthrottled); done(unthrottled);
    assert.equal(checkCall(unthrottled, await unthrottled.call('get_performance', idArgs)).split('\n')[0], header);
    checkRequests(unthrottled.requests.slice(before), gets(advertiserPath, campaignPath), reportSequence());
  }
});

test('C-3/C-4/C-5 names: cold, warm, stale no_exact refresh and independent zero_matches policy', async t => {
  const h = await composition(t);
  await t.test('C-3 cold name lookup loads both partner directories', async () => {
    h.steps.push(partnerList); directories(h); h.steps.push(campaignList); describe(h); done(h);
    const text = checkCall(h, await h.call('get_performance', nameArgs));
    checkRequests(h.requests, gets(partners, advertisers, advertisers, campaigns, advertiserPath, campaignPath), reportSequence());
    checkDirectories(h.requests);
    assert.equal(text.split('\n')[0], header);
    assert.ok(text.includes(`Advertiser: ${title} (${advertiserId})`));
    assert.ok(text.includes(`Campaign: ${campaignName} (${campaignId})`));
    assert.ok(!text.includes('partial name match'));
  });
  await t.test('C-4 warm name lookup keeps directories but still lists partners and campaigns', async () => {
    const before = h.requests.length;
    h.steps.push(partnerList, campaignList); describe(h); done(h);
    const text = checkCall(h, await h.call('get_performance', nameArgs));
    checkRequests(h.requests.slice(before), gets(partners, campaigns, advertiserPath, campaignPath), reportSequence());
    assert.equal(text.split('\n')[0], header);
    assert.ok(!text.includes('partial name match'));
  });
  await t.test('C-5 stale partial match refreshes for performance but not find_entities', async () => {
    h.advance(61_000);
    const before = h.requests.length;
    h.steps.push(partnerList); directories(h); describe(h, false); done(h, { target: 'advertiser' });
    const partialName = title.slice(0, -3);
    const text = checkCall(h, await h.call('get_performance', { advertiserName: partialName }));
    const requests = h.requests.slice(before);
    checkRequests(requests, gets(partners, advertisers, advertisers, advertiserPath), reportSequence());
    checkDirectories(requests);
    assert.ok(text.split('\n').includes(`Advertiser: ${title} (${advertiserId}) · partial name match`));
    h.advance(61_000); // Make a wrong no_exact policy observably reload; stay within the 10-minute TTL.
    const findBefore = h.requests.length;
    h.steps.push(partnerList);
    const found = await h.call('find_entities', { type: 'advertiser', name: partialName });
    assert.notEqual(found.result.isError, true);
    assert.ok(found.text.includes(advertiserId));
    checkRequests(h.requests.slice(findBefore), gets(partners), []);
    checkRedaction(h.lines);
  });
});

test('C-6 ambiguous campaign name lists both IDs without a Bid Manager request', async t => {
  const h = await composition(t);
  h.steps.push({ path: campaigns, respond: () => json({ campaigns: [campaign, { ...campaign, campaignId: siblingId }] }) });
  const text = checkCall(h, await h.call('get_performance', { advertiserId, campaignName }));
  checkRequests(h.requests, gets(campaigns), []);
  assert.ok(text.includes(`No report was started: the campaign name "${campaignName}" matched several campaigns. Ask the user which one, then call get_performance again with its campaignId.`));
  assert.ok(text.includes(campaignId)); assert.ok(text.includes(siblingId));
});

test('C-7 unknown campaign name returns its searched scope without a Bid Manager request', async t => {
  const h = await composition(t);
  h.steps.push(campaignList);
  const name = `${title} missing`;
  const text = checkCall(h, await h.call('get_performance', { advertiserId, campaignName: name }), true);
  checkRequests(h.requests, gets(campaigns), []);
  assert.ok(text.includes(`No report was started: the campaign name "${name}" matched no campaign (searched: advertiser ${advertiserId}).`));
});

test('C-8 an exact advertiser match in an incomplete partner search starts no report', async t => {
  const h = await composition(t);
  h.steps.push(partnerList); directories(h, true, true);
  const text = checkCall(h, await h.call('get_performance', { advertiserName: title }), true);
  checkRequests(h.requests, gets(partners, advertisers, advertisers), []);
  checkDirectories(h.requests);
  assert.ok(text.includes(`No report was started: the advertiser name "${title}" could not be searched completely, so no report was started.`));
  assert.ok(text.includes(advertiserId));
});

test('C-9 pending report makes exactly three status checks at 0, 5000 and 15000 ms', async t => {
  const h = await composition(t);
  describe(h, false);
  h.steps.push(created('advertiser'), ran, cleanupList,
    ...[0, 1, 2].map(() => ({ path: reportPath, respond: () => json(running) })));
  const text = checkCall(h, await h.call('get_performance', { advertiserId }));
  checkRequests(h.requests, gets(advertiserPath), reportSequence(true, 3));
  const checks = h.requests.filter(request => request.url.pathname === reportPath);
  assert.deepEqual(checks.map(request => request.at - checks[0].at), [0, 5_000, 15_000]);
  assert.ok(text.includes(`Report ${reportId} (query ${queryId}) is still RUNNING after waiting 15 s in this call. Call get_report again with the same IDs. Do not start the report again.`));
  assert.deepEqual(h.reads, []);
});

test('C-10a YOUTUBE refuses a failed advertiser lookup without a Bid Manager request', async t => {
  const h = await composition(t);
  describe(h, true, () => googleError(400));
  const text = checkCall(h, await h.call('get_performance', { ...idArgs, preset: 'youtube' }), true);
  checkRequests(h.requests, gets(advertiserPath, campaignPath), []);
  assert.ok(text.includes(`YouTube reports need the advertiser's partner, and the advertiser could not be read: Google rejected the request: ${title}`));
});

test('C-10b REACH refuses an advertiser without a partner without a Bid Manager request', async t => {
  const h = await composition(t);
  const { partnerId: _partnerId, ...withoutPartner } = advertiser;
  describe(h, false, () => json(withoutPartner));
  const text = checkCall(h, await h.call('get_performance', { advertiserId, preset: 'reach' }), true);
  checkRequests(h.requests, gets(advertiserPath), []);
  assert.ok(text.includes("Reach reports need the advertiser's partner, and Google's record of the advertiser has no partner."));
});

test('C-11 YOUTUBE includes advertiser, campaign and partner filters in four requests', async t => {
  const h = await composition(t);
  describe(h); done(h, { preset: 'youtube' });
  const text = checkCall(h, await h.call('get_performance', { ...idArgs, preset: 'youtube' }));
  checkRequests(h.requests, gets(advertiserPath, campaignPath), reportSequence());
  assert.equal(text.split('\n')[0], header);
  assert.ok(!text.includes('Requested row'));
});

test('C-12 STANDARD still starts the report after an advertiser 400', async t => {
  const h = await composition(t);
  describe(h, true, () => googleError(400)); done(h);
  const text = checkCall(h, await h.call('get_performance', idArgs));
  checkRequests(h.requests, gets(advertiserPath, campaignPath), reportSequence());
  assert.ok(text.includes(`Warning: The advertiser's details could not be read (Google rejected the request: ${title}); the report runs without them.`));
});

test('C-13 a complete lookup returning after R makes no describe or Bid Manager request', async t => {
  const h = await composition(t);
  h.steps.push({ path: campaigns, takes: 46_000, respond: () => json({ campaigns: [campaign] }) });
  const text = checkCall(h, await h.call('get_performance', { advertiserId, campaignName }), true);
  checkRequests(h.requests, gets(campaigns), []);
  assert.ok(text.includes('The name lookup took too long to start the report in this call. Call get_performance again: the lookup results are cached for 10 minutes, so it will be faster.'));
});

test('C-14 a Bid Manager daily latch still permits DV360 reads and blocks create before fetch', async t => {
  const h = await composition(t);
  h.steps.push({ path: queries, respond: () => googleError(403, 'PERMISSION_DENIED', 'dailyLimitExceeded') });
  const latched = await h.call('list_saved_reports');
  assert.equal(latched.result.isError, true);
  checkRequests(h.requests, [], gets(queries));
  const before = h.requests.length;
  describe(h);
  const call = await h.call('get_performance', idArgs);
  const text = checkCall(h, call, true);
  checkRequests(h.requests.slice(before), gets(advertiserPath, campaignPath), []);
  assert.equal(text, 'The daily Bid Manager request quota is used up. It resets at midnight Pacific time.');
  assert.ok(call.events.some(event => event.type === 'google.latch_blocked'));
});
