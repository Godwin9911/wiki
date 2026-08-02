# apps/wiki/wiki/oauth_bridge.py
#
# Exposes Frappe's real OAuth authorize-URL generation as a whitelisted API,
# so an external app (e.g. a Sails/Planka server) can fetch a genuine,
# single-use `state`-backed auth_url server-to-server, instead of only being
# able to get one by rendering Frappe's /login page in a browser.
#
# This calls the exact same get_oauth2_authorize_url() that Frappe's own
# /login page uses to build each provider's button -- so the state it
# creates is 100% real and will round-trip correctly through
# consume_oauth_state() on the way back.

import frappe
from frappe.utils.oauth import get_oauth2_authorize_url


@frappe.whitelist(allow_guest=True, methods=["GET"])
def get_authorize_url(provider: str, redirect_to: str = "/app"):
	"""
	GET /api/method/wiki.oauth_bridge.get_authorize_url?provider=<name>&redirect_to=<path>

	`provider` must match the `name` of an enabled Social Login Key record
	(this is the same value used in login.py: provider.name, NOT provider_name).

	Returns: {"auth_url": "https://your-frappe-site/oauth/authorize?..."}
	"""
	social_login_key = frappe.get_all(
		"Social Login Key",
		filters={"name": provider, "enable_social_login": 1},
		fields=["name"],
		limit=1,
	)
	if not social_login_key:
		frappe.throw(f"No enabled Social Login Key found for provider '{provider}'")

	auth_url = get_oauth2_authorize_url(provider, redirect_to)
	return {"auth_url": auth_url}
