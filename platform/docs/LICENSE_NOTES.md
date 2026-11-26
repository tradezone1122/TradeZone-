# License notes
- Policy applied: only MIT / Apache-2.0 sources were merged.
- The `Software_Code_License-v2.pdf` supplied is an unsigned document (both signature lines blank) and cannot be verified as a grant from Anthropic. The license files inside the claude-code archives say "All rights reserved" and (in `claude-code-source-code-full-main`) "UNLICENSED - NOT FOR REDISTRIBUTION ... leaked proprietary source". That code was not read for merging and nothing from it is in this tree.
- GPL/AGPL projects were not merged. Merging them would make the whole platform GPL/AGPL.
- claude-code-sandbox declares MIT in package.json; only its Docker-isolation idea was reused (licenses/claude-code-sandbox.NOTE).
- Preserved notices: `licenses/` (MIT for knowledge-rag, Apache-2.0 + third-party notices for Splaude). Apache-2.0 requires keeping the license and noting changes (see CHANGELOG.md).
