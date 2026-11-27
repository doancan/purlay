# D-352. The server publishes its own privacy policy and terms addresses (#1615)

**Decided.** Build on D-278's server identity. The server administrator can set a privacy policy and
terms of service address separately in the server identity card. Both take an absolute HTTPS address
without credentials, or can be cleared. Existing installations and new servers leave both unset until
an administrator supplies them. The existing server preference transaction records an identity audit
entry when either value changes.

Native clients can read public identity before sign-in through the existing `GET /api/instance`, now
named `getInstanceInfo` in the contract bundle. Both new response members are optional so that the
same client can read older servers. Current servers send `null` for an unset address. This is an
additive change with the same contract version (D-58).

**Cost of reversing.** Remove the two address fields from the public response and the console.
Leaving their nullable columns in place preserves the settings if the feature returns.
