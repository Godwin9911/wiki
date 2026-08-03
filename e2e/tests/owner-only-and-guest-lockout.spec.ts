import { expect, test } from '@playwright/test';
import { createDoc, getDoc } from '../helpers/frappe';
import { appUrl } from '../helpers/routes';
import {
	type WikiDocument,
	type WikiSpace,
	cleanupWikiSpacesByRoute,
	createTestWikiDocument,
	createTestWikiSpace,
} from '../helpers/wiki';

/**
 * Guest lockout: every wiki route requires login now (see
 * specs/owner_only_and_guest_lockout.md). And the "Owner Only" toggle,
 * which additionally hides a page/space from everyone except its owner
 * and Admin-role users.
 *
 * The default Playwright project reuses an authenticated (Administrator)
 * storage state (see auth.setup.ts) -- the Guest tests below deliberately
 * open a *fresh, unauthenticated* browser context so they exercise a real
 * anonymous visit, not the shared logged-in session.
 */
test.describe('Guest lockout', () => {
	const route = `guest-lockout-${Date.now()}`;
	let space: WikiSpace;
	let doc: WikiDocument;

	test.beforeAll(async ({ request }) => {
		space = await createTestWikiSpace(request, { route, is_published: true });
		const spaceDoc = await getDoc<{ root_group: string }>(
			request,
			'Wiki Space',
			space.name,
		);
		doc = await createTestWikiDocument(request, {
			title: 'Guest Lockout Page',
			route: `${route}/guest-page`,
			is_published: true,
			wiki_space: space.name,
			parent_wiki_document: spaceDoc.root_group,
		});
	});

	test.afterAll(async ({ request }) => {
		await cleanupWikiSpacesByRoute(request, route);
	});

	test('anonymous visitor is redirected to login, not shown content', async ({
		browser,
	}) => {
		// A context with no storage state at all -- genuinely anonymous, unlike
		// page.context().newPage() elsewhere in this suite (see public-pages.spec.ts),
		// which inherits the authenticated session.
		const anonContext = await browser.newContext({ storageState: undefined });
		const anonPage = await anonContext.newPage();

		await anonPage.goto(`/${doc.route}`);
		await anonPage.waitForURL(/\/login/, { timeout: 10000 });
		expect(anonPage.url()).toContain('/login');
		expect(anonPage.url()).toContain('redirect-to=');

		await anonContext.close();
	});

	test('anonymous visit to the SPA is also redirected to login', async ({
		browser,
	}) => {
		const anonContext = await browser.newContext({ storageState: undefined });
		const anonPage = await anonContext.newPage();

		await anonPage.goto(appUrl('spaces', space.name));
		await anonPage.waitForURL(/\/login/, { timeout: 10000 });
		expect(anonPage.url()).toContain('/login');

		await anonContext.close();
	});
});

test.describe('Owner Only', () => {
	const route = `owner-only-${Date.now()}`;
	let space: WikiSpace;
	let doc: WikiDocument;
	let technicianEmail: string;
	const technicianPassword = 'OwnerOnlyE2E!23';

	test.beforeAll(async ({ request }) => {
		space = await createTestWikiSpace(request, { route, is_published: true });
		const spaceDoc = await getDoc<{ root_group: string }>(
			request,
			'Wiki Space',
			space.name,
		);
		doc = await createTestWikiDocument(request, {
			title: 'Owner Only Page',
			route: `${route}/owner-only-page`,
			is_published: true,
			wiki_space: space.name,
			parent_wiki_document: spaceDoc.root_group,
		});

		// The default test session (auth.setup.ts) is Administrator, which is a
		// permissions-bypass manager but does not automatically hold the literal
		// "Admin" role the Owner Only toggle is gated on (see stores/user.js
		// isAdmin) -- grant it explicitly via the standard Has Role child table.
		await createDoc(request, 'Has Role', {
			parent: 'Administrator',
			parenttype: 'User',
			parentfield: 'roles',
			role: 'Admin',
		}).catch(() => {
			// Already has the role from a previous run -- fine.
		});

		technicianEmail = `wiki-e2e-technician-${Date.now()}@example.com`;
		await createDoc(request, 'User', {
			email: technicianEmail,
			first_name: 'E2E Technician',
			send_welcome_email: 0,
			new_password: technicianPassword,
		});
		await createDoc(request, 'Has Role', {
			parent: technicianEmail,
			parenttype: 'User',
			parentfield: 'roles',
			role: 'Technician',
		});
	});

	test.afterAll(async ({ request }) => {
		await cleanupWikiSpacesByRoute(request, route);
	});

	test('Admin toggles Owner Only in Page Settings and sees the red pill', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto(appUrl('spaces', space.name, 'page', doc.name));
		await expect(page.getByPlaceholder('Page title')).toHaveValue(doc.title, {
			timeout: 15000,
		});

		await page.getByRole('button', { name: 'More actions' }).click();
		await page.getByRole('menuitem', { name: 'Page settings' }).click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 10000 });

		const ownerOnlySwitch = dialog.getByText('Owner Only').locator('..').getByRole('switch');
		await expect(ownerOnlySwitch).toBeVisible();
		await ownerOnlySwitch.click();

		const saveButton = dialog.getByRole('button', { name: 'Save', exact: true });
		await expect(saveButton).toBeEnabled();
		await saveButton.click();
		await expect(saveButton).toBeDisabled({ timeout: 10000 });
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(page.getByText('Owner Only', { exact: true })).toBeVisible({
			timeout: 10000,
		});
	});

	test('Technician cannot open an Owner Only page, but can see a sibling published page', async ({
		browser,
		request,
	}) => {
		// Created via the default (Administrator) request context, before
		// switching to Technician -- a plain Technician has no create access
		// outside the change-request flow.
		const spaceDoc = await getDoc<{ root_group: string }>(
			request,
			'Wiki Space',
			space.name,
		);
		const siblingDoc = await createTestWikiDocument(request, {
			title: 'Sibling Non-Owner-Only Page',
			route: `${route}/sibling-page`,
			is_published: true,
			wiki_space: space.name,
			parent_wiki_document: spaceDoc.root_group,
		});

		// A separate, independently-authenticated context -- this must NOT reuse
		// the Administrator storage state from auth.setup.ts.
		const technicianContext = await browser.newContext({ storageState: undefined });
		const loginResponse = await technicianContext.request.post('/api/method/login', {
			form: { usr: technicianEmail, pwd: technicianPassword },
		});
		expect(loginResponse.ok()).toBeTruthy();

		const technicianPage = await technicianContext.newPage();

		// Direct URL to the page marked Owner Only in the previous test: denied,
		// same 404 shape as a genuinely nonexistent route (no leak).
		await technicianPage.goto(`/${doc.route}`);
		await expect(
			technicianPage.getByText(/page not found/i).first(),
		).toBeVisible({ timeout: 10000 });

		// A sibling, non-owner-only page in the same space stays visible --
		// Owner Only is additive, not a space-wide lockout.
		await technicianPage.goto(`/${siblingDoc.route}`);
		await expect(
			technicianPage.getByText(siblingDoc.title).first(),
		).toBeVisible({ timeout: 10000 });

		await technicianContext.close();
	});
});

test.describe('Owner Only — Group', () => {
	const route = `owner-only-group-${Date.now()}`;
	let space: WikiSpace;
	let group: WikiDocument;
	let child: WikiDocument;
	let technicianEmail: string;
	const technicianPassword = 'OwnerOnlyGroupE2E!23';

	// Reuse the same three-dot menu -> menuitem interaction change-request-flow.spec.ts
	// uses for group rows (there's no named "More actions" button for a group
	// the way there is for an open page, only the icon-only trailing button).
	async function openGroupMenu(page: import('@playwright/test').Page, title: string) {
		const groupItem = page
			.locator('aside [role="treeitem"]', { hasText: title })
			.first();
		await groupItem.hover();
		await groupItem.locator('> div').first().locator('button').last().click();
	}

	test.beforeAll(async ({ request }) => {
		space = await createTestWikiSpace(request, { route, is_published: true });
		const spaceDoc = await getDoc<{ root_group: string }>(
			request,
			'Wiki Space',
			space.name,
		);
		group = await createTestWikiDocument(request, {
			title: 'Owner Only Group',
			is_group: true,
			wiki_space: space.name,
			parent_wiki_document: spaceDoc.root_group,
		});
		child = await createTestWikiDocument(request, {
			title: 'Child Of Owner Only Group',
			route: `${route}/child-page`,
			is_published: true,
			wiki_space: space.name,
			parent_wiki_document: group.name,
		});

		await createDoc(request, 'Has Role', {
			parent: 'Administrator',
			parenttype: 'User',
			parentfield: 'roles',
			role: 'Admin',
		}).catch(() => {
			// Already has the role from a previous run -- fine.
		});

		technicianEmail = `wiki-e2e-group-technician-${Date.now()}@example.com`;
		await createDoc(request, 'User', {
			email: technicianEmail,
			first_name: 'E2E Group Technician',
			send_welcome_email: 0,
			new_password: technicianPassword,
		});
		await createDoc(request, 'Has Role', {
			parent: technicianEmail,
			parenttype: 'User',
			parentfield: 'roles',
			role: 'Technician',
		});
	});

	test.afterAll(async ({ request }) => {
		await cleanupWikiSpacesByRoute(request, route);
	});

	test('Admin toggles Owner Only on a Group via its dropdown menu and sees the badge', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto(appUrl('spaces', space.name));
		await page.waitForLoadState('networkidle');

		await openGroupMenu(page, group.title);
		await page.getByRole('menuitem', { name: 'Owner Only' }).click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 10000 });

		const ownerOnlySwitch = dialog.getByRole('switch').first();
		await expect(ownerOnlySwitch).toBeVisible();
		await ownerOnlySwitch.click();

		const saveButton = dialog.getByRole('button', { name: 'Save', exact: true });
		await expect(saveButton).toBeEnabled();
		await saveButton.click();
		await expect(saveButton).toBeDisabled({ timeout: 10000 });
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		const groupItem = page
			.locator('aside [role="treeitem"]', { hasText: group.title })
			.first();
		await expect(groupItem.getByText('Owner Only', { exact: true })).toBeVisible({
			timeout: 10000,
		});
	});

	test('Technician sees no trace of the group or its child in the editor tree or by direct URL, and access is restored after toggling off', async ({
		page,
		browser,
	}) => {
		const technicianContext = await browser.newContext({ storageState: undefined });
		const loginResponse = await technicianContext.request.post('/api/method/login', {
			form: { usr: technicianEmail, pwd: technicianPassword },
		});
		expect(loginResponse.ok()).toBeTruthy();
		const technicianPage = await technicianContext.newPage();
		await technicianPage.setViewportSize({ width: 1200, height: 900 });

		// Gone from the space-management (editor) sidebar tree, not just the
		// public reader nav -- this is the gap this feature closes (get_cr_tree
		// previously applied no per-document Owner Only filtering at all).
		await technicianPage.goto(appUrl('spaces', space.name));
		await technicianPage.waitForLoadState('networkidle');
		await expect(
			technicianPage.locator('aside').getByText(group.title, { exact: true }),
		).toHaveCount(0);
		await expect(
			technicianPage.locator('aside').getByText(child.title, { exact: true }),
		).toHaveCount(0);

		// Direct URL to the child: denied, same 404 shape as nonexistent --
		// cascaded from the group's flag even though the child's own is unset.
		await technicianPage.goto(`/${child.route}`);
		await expect(
			technicianPage.getByText(/page not found/i).first(),
		).toBeVisible({ timeout: 10000 });

		// Toggle off as Admin, then confirm the Technician regains access.
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto(appUrl('spaces', space.name));
		await page.waitForLoadState('networkidle');
		await openGroupMenu(page, group.title);
		await page.getByRole('menuitem', { name: 'Owner Only' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 10000 });
		const ownerOnlySwitch = dialog.getByRole('switch').first();
		await ownerOnlySwitch.click();
		const saveButton = dialog.getByRole('button', { name: 'Save', exact: true });
		await expect(saveButton).toBeEnabled();
		await saveButton.click();
		await expect(saveButton).toBeDisabled({ timeout: 10000 });

		await technicianPage.goto(`/${child.route}`);
		await expect(technicianPage.getByText(child.title).first()).toBeVisible({
			timeout: 10000,
		});

		await technicianContext.close();
	});
});
