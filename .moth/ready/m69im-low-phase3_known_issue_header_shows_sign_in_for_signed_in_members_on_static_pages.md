Known issue, accepted for now.

What: a member who is signed in on the Phase 3 site still sees "Sign in" and "Subscribe" in the header. A signed-in member gets "Account" on Phase 2.

Why: the theme chooses the header on the server from the member state. Phase 3 serves pages pre-rendered once without a member, so every visitor gets the anonymous header. Sign-in itself works (the member API answers with the member, verified in a browser signed in as the test member).

Impact: cosmetic. All published posts are public, so no content is wrongly gated or exposed. Members can still reach their account through the sign-in dialog.

Decided: keep as a known issue for now; no change before or after the cutover.

Options if it is picked up later:
- footer code-injection script that asks the member API (answered at the edge for anonymous visitors) and swaps the header links to Account when it answers 200; needs a site settings change and a regenerate
- theme template change to a neutral link that works for everyone

Rejected for now: rendering pages per member (defeats the static design).

Related: nx54g (Phase 3 Lambda). It belongs on the post-cutover validation list as a known difference from Phase 2.
