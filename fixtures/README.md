# Fixture governance

All checked-in fixtures are synthetic, repository-authored evidence. They
contain no real credentials, real user repositories, copied private
transcripts, or external-system captures. The metadata manifests bind every
governed source byte to its provenance, consumers, and regeneration process.
`generatorVersion` versions the manifest generator; `contentHash` is SHA-256
over the compact JSON file-manifest in its declared, lexicographically sorted
order. Metadata files never hash themselves.

The non-golden R1 groups are hand-authored. After changing one, preserve its
published schema and refresh only its manifest:

```bash
npm run fixtures:manifest -- fixtures/repos
npm run fixtures:manifest -- fixtures/suites/reference
npm run fixtures:manifest -- fixtures/trajectories
npm run fixtures:manifest -- fixtures/task-format
npm run fixtures:manifest -- fixtures/adapter-frames
npm run fixtures:manifest -- fixtures/contract-events
npm run check:fixtures
```

Review both the source diff and the refreshed hashes. A manifest refresh does
not approve the semantic change. Never paste production output, credentials,
personal paths, or private transcripts into these directories. Synthetic
secret canaries must be explicitly registered in that group's metadata before
use; the R1 groups currently register none.

Generated goldens remain on their separate, write-authorized path:

```bash
npm run fixtures:regen -- fixtures/goldens/r1
```

Golden changes additionally require exactly one substantive PR or commit line
in this form:

```text
Golden semantic review: explain the changed meaning and why it is correct
```

Do not use the manifest command to rewrite golden output, and do not hand-edit
generated golden bytes or their metadata.
