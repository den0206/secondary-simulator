# Third-Party Notices

Secondary Simulator itself is distributed under the [MIT License](LICENSE.md).
The VSIX additionally bundles the third-party component listed below, which is
covered by its own license.

---

## mobilecli

- **Version bundled**: 1.0.5
- **Copyright**: Copyright 2025-2026 Mobile Next HQ, Inc.
- **License**: Functional Source License, Version 1.1, ALv2 Future License
  (FSL-1.1-ALv2), full text below
- **Homepage**: https://github.com/mobile-next/mobilecli
- **Corresponding Source**: https://github.com/mobile-next/mobilecli/tree/f498fa525e216fa37017c9c102836cfb9929cbc5
  (tag `1.0.5`, tagged 2026-08-26)

### What is bundled

Only the prebuilt macOS binaries `bin/mobilecli-darwin-arm64` /
`bin/mobilecli-darwin-amd64` and the `index.js` launcher, unmodified, as
published to npm. Secondary Simulator runs mobilecli as a **separate process**
and communicates with it over JSON-RPC 2.0; it neither links against it nor
modifies it.

### Note on the license

Two things about this component's licensing do not match at first glance, so
they are recorded here.

**The npm metadata is wrong.** The npm package `mobilecli` declares
`"license": "MIT"`. That declaration does not match the upstream repository.
This notice follows the `LICENSE` file that ships with the source of the
bundled version, not the npm metadata.

**Upstream relicensed mid-history.** Up to and including `0.1.64` the
`LICENSE` file was AGPL-3.0. From `0.3.75` (2026-05-24) onward it is
FSL-1.1-ALv2, which is a source-available license and not an OSI-approved
open source license. Secondary Simulator bundled `@mobilenext/mobilecli@0.1.64`
(AGPL-3.0) until it moved to `mobilecli` 1.0.x (FSL-1.1-ALv2); the move was
necessary because the upstream fix for Android screen recordings being written
without an MP4 `moov` atom landed in `0.3.77`, i.e. only in relicensed
versions.

Two FSL clauses bear on redistributing this VSIX:

- **Redistribution** requires that a copy of or a link to the license terms
  travels with every redistributed copy, and that copyright notices are kept.
  This file satisfies that and is deliberately included in the VSIX (see
  `.vscodeignore`).
- **Permitted Purpose** excludes a *Competing Use*, defined as making the
  software available to others in a **commercial** product or service that
  substitutes for it or offers substantially similar functionality. Secondary
  Simulator is distributed free of charge under the MIT License and invokes
  mobilecli as a separate process rather than reselling it, so it is
  distributed on the understanding that this is a Permitted Purpose.

An additional Apache License 2.0 grant becomes effective on the second
anniversary of each version's initial availability, per the Grant of Future
License clause below.

### Full license text (FSL-1.1-ALv2)

```
Functional Source License, Version 1.1, ALv2 Future License

Copyright 2025-2026 Mobile Next HQ, Inc.

Terms and Conditions

Licensor ("We")
The party offering the Software under these Terms and Conditions.

The Software
The "Software" is each version of the software that we make available under these Terms and Conditions, as indicated by our inclusion of these Terms and Conditions with the Software.

License Grant
Subject to your compliance with this License Grant and the Patents, Redistribution and Trademark clauses below, we hereby grant you the right to use, copy, modify, create derivative works, publicly perform, publicly display and redistribute the Software for any Permitted Purpose identified below.

Permitted Purpose
A Permitted Purpose is any purpose other than a Competing Use. A Competing Use means making the Software available to others in a commercial product or service that:

1. substitutes for the Software;
2. substitutes for any other product or service we offer using the Software that exists as of the date we make the Software available; or
3. offers the same or substantially similar functionality as the Software.

Permitted Purposes specifically include using the Software:

1. for your internal use and access;
2. for non-commercial education;
3. for non-commercial research; and
4. in connection with professional services that you provide to a licensee using the Software in accordance with these Terms and Conditions.

Patents
To the extent your use for a Permitted Purpose would necessarily infringe our patents, the license grant above includes a license under our patents. If you make a claim against any party that the Software infringes or contributes to the infringement of any patent, then your patent license to the Software ends immediately.

Redistribution
The Terms and Conditions apply to all copies, modifications and derivatives of the Software.

If you redistribute any copies, modifications or derivatives of the Software, you must include a copy of or a link to these Terms and Conditions and not remove any copyright notices provided in or with the Software.

Disclaimer
THE SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF FITNESS FOR A PARTICULAR PURPOSE, MERCHANTABILITY, TITLE OR NON-INFRINGEMENT.

Trademarks
Except for displaying the License Details and identifying us as the origin of the Software, you have no right under these Terms and Conditions to use our trademarks, trade names, service marks or product names.

Grant of Future License
An additional Apache License, Version 2.0 becomes effective on the second anniversary of the Software's initial availability. After that date, users may alternatively use the Software under the Apache License, Version 2.0.
```
