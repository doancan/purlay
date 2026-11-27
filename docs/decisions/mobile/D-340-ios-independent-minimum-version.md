# D-340. The iOS client has an independent minimum version and contract (#1560)

**Decided.** Apply D-186's existing admission check to `ios` with independent settings for its application
version, wire contract and HTTPS update address. An unset limit admits the platform as before. The public
handshake advertises `minClient.ios`, and its schema leaves that property optional so an older server's
handshake remains valid. The contract version stays the same under D-58.

**Rejected.** A shared version floor for macOS and iOS would tie together releases with separate version
numbers and could refuse a current release on one platform when the other raises its minimum.

**Cost of reversing.** Clear the iOS settings to admit clients of any version.
