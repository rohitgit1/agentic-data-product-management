import Link from 'next/link'
import { Mermaid } from '@/components/mermaid'
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader } from '@/components/ui'
import { ARTIFACT_TYPES } from '@/lib/artifacts/registry'
import {
  ENUMERATIONS,
  INVARIANT_ANCHORS,
  SCHEMA_PATH,
  SPINE_MODELS,
  enumerationForColumn,
  erDiagram,
  loadDataModel,
  type AnnotatedModel,
  type DataModel,
} from '@/lib/datamodel/registry'
import type { ParsedField, ParsedModel, RelationEdge } from '@/lib/datamodel/parse'
import { STAGES } from '@/lib/lifecycle/stages'

export const dynamic = 'force-dynamic'

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
}

function formatType(field: ParsedField): string {
  return `${field.type}${field.list ? '[]' : ''}${field.optional ? '?' : ''}`
}

function formatDefault(value: string): string {
  const literal = value.replace(/^"(.*)"$/, '$1')
  // An empty-string default is a real choice; rendering it as blank would read as "no default".
  return literal === '' ? '""' : literal
}

function columnRole(model: ParsedModel, field: ParsedField, edgesOut: RelationEdge[]): string[] {
  const roles: string[] = []
  if (model.primaryKey.includes(field.name)) roles.push('PK')
  if (edgesOut.some((edge) => edge.foreignKeys.includes(field.name))) roles.push('FK')
  if (field.isUnique) roles.push('U')
  if (model.uniques.some((unique) => unique.includes(field.name))) roles.push('U*')
  return roles
}

function FieldTable({ annotated }: { annotated: AnnotatedModel }) {
  const { model, edgesOut } = annotated
  const scalars = model.fields.filter((field) => field.relation === null)

  return (
    <table className="w-full min-w-[720px] text-xs">
      <thead className="bg-ink-50 text-left uppercase tracking-wide text-ink-500">
        <tr>
          <th scope="col" className="px-4 py-2">
            Column
          </th>
          <th scope="col" className="px-3 py-2">
            Type
          </th>
          <th scope="col" className="px-3 py-2">
            Key
          </th>
          <th scope="col" className="px-3 py-2">
            Default
          </th>
          <th scope="col" className="px-3 py-2">
            Notes
          </th>
        </tr>
      </thead>
      <tbody>
        {scalars.map((field) => {
          const roles = columnRole(model, field, edgesOut)
          const enumeration = enumerationForColumn(model.name, field.name)
          const reference = edgesOut.find((edge) => edge.foreignKeys.includes(field.name))
          return (
            <tr key={field.name} className="border-t border-ink-100 align-top">
              <th scope="row" className="px-4 py-1.5 text-left font-medium text-ink-900">
                {field.name}
              </th>
              <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-ink-700">
                {formatType(field)}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-ink-600">
                {roles.length ? roles.join(' ') : <span className="text-ink-300">·</span>}
              </td>
              <td className="px-3 py-1.5 font-mono text-[11px] text-ink-600">
                {field.default === null ? (
                  <span className="text-ink-300">·</span>
                ) : (
                  formatDefault(field.default)
                )}
              </td>
              <td className="px-3 py-1.5 text-ink-600">
                {field.doc ? <p>{field.doc}</p> : null}
                {reference ? (
                  <p>
                    References{' '}
                    <a href={`#model-${slug(reference.to)}`} className="text-accent-600 hover:underline">
                      {reference.to}
                    </a>
                    .
                  </p>
                ) : null}
                {enumeration ? (
                  <p>
                    One of{' '}
                    <a href="#enumerations" className="text-accent-600 hover:underline">
                      {enumeration.label}
                    </a>
                    : {enumeration.values.join(', ')}.
                  </p>
                ) : null}
                {field.name.endsWith('Json') ? <p>JSON payload, parsed at the boundary.</p> : null}
                {field.updatedAt ? <p>Maintained by the ORM on every write.</p> : null}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ModelCard({ annotated }: { annotated: AnnotatedModel }) {
  const { model, note, edgesOut, edgesIn } = annotated

  return (
    <Card as="article">
      <div id={`model-${slug(model.name)}`} className="scroll-mt-24">
        <CardHeader
          title={model.name}
          description={note?.purpose ?? 'No reading note written for this table yet.'}
          actions={
            <div className="flex flex-wrap justify-end gap-1">
              {annotated.appendOnly ? <Badge tone="warn">Append-only</Badge> : null}
              {annotated.archivable ? <Badge tone="neutral">Archivable</Badge> : null}
              {(note?.invariants ?? []).map((invariant) => (
                <Badge key={invariant} tone="info" title="Invariant from CLAUDE.md">
                  <a href="#invariants">Invariant {invariant}</a>
                </Badge>
              ))}
            </div>
          }
        />
        <CardBody className="p-0">
          {note?.writeRule ? (
            <p className="border-b border-ink-100 bg-ink-50/60 px-5 py-2 text-xs text-ink-700">
              <span className="font-semibold text-ink-800">Write rule: </span>
              {note.writeRule}
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <FieldTable annotated={annotated} />
          </div>
          <div className="grid gap-3 border-t border-ink-100 px-5 py-3 text-xs text-ink-700 md:grid-cols-2">
            <div>
              <p className="font-semibold uppercase tracking-wide text-ink-500">Belongs to</p>
              {edgesOut.length ? (
                <ul className="mt-1 space-y-0.5">
                  {edgesOut.map((edge) => (
                    <li key={`${edge.field}-${edge.to}`}>
                      <a href={`#model-${slug(edge.to)}`} className="text-accent-600 hover:underline">
                        {edge.to}
                      </a>{' '}
                      <span className="text-ink-500">
                        via {edge.foreignKeys.join(', ')}
                        {edge.optional ? ', optional' : ''}
                        {edge.unique ? ', one-to-one' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-ink-500">Nothing — this table stands on its own.</p>
              )}
            </div>
            <div>
              <p className="font-semibold uppercase tracking-wide text-ink-500">Referenced by</p>
              {edgesIn.length ? (
                <ul className="mt-1 space-y-0.5">
                  {edgesIn.map((edge) => (
                    <li key={`${edge.from}-${edge.field}`}>
                      <a
                        href={`#model-${slug(edge.from)}`}
                        className="text-accent-600 hover:underline"
                      >
                        {edge.from}
                      </a>
                      <span className="text-ink-500">.{edge.field}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-ink-500">Nothing references this table.</p>
              )}
            </div>
          </div>
          {model.indexes.length ? (
            <p className="border-t border-ink-100 px-5 py-2 font-mono text-[11px] text-ink-500">
              Indexes: {model.indexes.map((index) => `(${index.join(', ')})`).join('  ')}
            </p>
          ) : null}
        </CardBody>
      </div>
    </Card>
  )
}

function GroupDiagram({ dataModel, names, title }: { dataModel: DataModel; names: string[]; title: string }) {
  const { chart, external } = erDiagram(dataModel, names)
  return (
    <div>
      <Mermaid chart={chart} title={title} />
      {external.length ? (
        <p className="mt-2 text-xs text-ink-600">
          <span className="font-medium text-ink-700">Crosses into other groups: </span>
          {external
            .map((edge) => `${edge.from}.${edge.field} → ${edge.to}`)
            .join(' · ')}
        </p>
      ) : null}
    </div>
  )
}

export default async function DataModelPage() {
  const dataModel = await loadDataModel()
  const { totals } = dataModel

  const stats: { label: string; value: string }[] = [
    { label: 'Tables', value: String(totals.models) },
    { label: 'Columns', value: String(totals.columns) },
    { label: 'Foreign keys', value: String(totals.relations) },
    { label: 'Enumerated columns', value: String(totals.enumeratedColumns) },
    { label: 'Append-only tables', value: String(dataModel.models.filter((m) => m.appendOnly).length) },
    { label: 'Default store', value: dataModel.schema.provider },
  ]

  return (
    <div>
      <PageHeader
        eyebrow="Enable"
        title="Data model"
        description="Every table behind Agentic Data Product Management, what it is for in plain language, and which of the product's invariants it carries. Read straight from the schema at request time, so it cannot drift from what the application actually stores."
      />

      <section className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardBody>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold text-ink-900">{stat.value}</p>
            </CardBody>
          </Card>
        ))}
      </section>

      {dataModel.unannotated.length || dataModel.orphanedNotes.length ? (
        <div className="mb-8">
          <Callout tone="warn" title="This page is out of step with the schema">
            {dataModel.unannotated.length ? (
              <p>Tables with no reading note: {dataModel.unannotated.join(', ')}.</p>
            ) : null}
            {dataModel.orphanedNotes.length ? (
              <p>Notes for tables that no longer exist: {dataModel.orphanedNotes.join(', ')}.</p>
            ) : null}
          </Callout>
        </div>
      ) : null}

      <section className="mb-8">
        <Card>
          <CardHeader
            title="How to read this page"
            description={`Structure — tables, columns, types, defaults, keys and indexes — is parsed from ${SCHEMA_PATH}. Only the plain-language notes are written by hand, and a test fails if a table is added without one.`}
          />
          <CardBody className="text-sm text-ink-700">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>PK</strong> primary key · <strong>FK</strong> foreign key ·{' '}
                <strong>U</strong> unique column · <strong>U*</strong> part of a multi-column unique
                constraint.
              </li>
              <li>
                A <code>?</code> after a type means the column may be empty; <code>[]</code> means the
                other table points back here many times.
              </li>
              <li>
                Columns ending in <code>Json</code> hold a structured payload validated by a Zod
                schema at the boundary. SQLite has no enum type, so enumerated columns are strings
                whose permitted values are listed against the column and defined once in code.
              </li>
              <li>
                Nothing is hard-deleted. Tables that can leave circulation carry{' '}
                <code>archivedAt</code>; tables marked append-only are only ever inserted into.
              </li>
            </ul>
          </CardBody>
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
          The spine
        </h2>
        <Card>
          <CardHeader
            title="Request → product → stage run → gate → approval"
            description="The path a single piece of work takes, and the evidence it leaves. Everything else in the model hangs off this line."
          />
          <CardBody>
            <GroupDiagram
              dataModel={dataModel}
              names={SPINE_MODELS}
              title="Core entity-relationship diagram"
            />
            <div className="mt-4 grid gap-3 text-sm text-ink-700 md:grid-cols-2">
              <p>
                A consumer submits a <strong>ProductRequest</strong>. Triage approval — never a
                direct promotion — turns it into a <strong>DataProduct</strong>, which opens one{' '}
                <strong>StageRun</strong> per pass through each of the {STAGES.length} stages. Each
                run has exactly one <strong>Gate</strong>, and a gate moves to approved only when the
                required <strong>Approval</strong> rows meet quorum with no veto.
              </p>
              <p>
                The artifacts a stage produces are stored as content-hashed{' '}
                <strong>ArtifactVersion</strong> rows with per-field{' '}
                <strong>FieldProvenance</strong>. A gate pins the exact versions it relied on in{' '}
                <strong>GateEvidence</strong>, which is what lets a later commit flip that approval
                to stale. <strong>AgentAction</strong> and <strong>AgentProposal</strong> sit beside
                the artifacts, never inside them: an agent proposes a field, a human disposes of it.
              </p>
            </div>
          </CardBody>
        </Card>
      </section>

      <nav aria-label="Table groups" className="mb-8">
        <Card>
          <CardBody className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {dataModel.groups.map(({ group, models }) => (
              <a key={group.key} href={`#group-${group.key}`} className="text-accent-600 hover:underline">
                {group.title}
                <span className="ml-1 text-ink-500">({models.length})</span>
              </a>
            ))}
            <a href="#invariants" className="text-accent-600 hover:underline">
              Invariants in the schema
            </a>
            <a href="#enumerations" className="text-accent-600 hover:underline">
              Enumerations
            </a>
            <a href="#payloads" className="text-accent-600 hover:underline">
              Artifact payloads
            </a>
          </CardBody>
        </Card>
      </nav>

      {dataModel.groups.map(({ group, models }) => (
        <section key={group.key} id={`group-${group.key}`} className="mb-10 scroll-mt-24">
          <h2 className="text-lg font-semibold text-ink-900">{group.title}</h2>
          <p className="mb-4 max-w-4xl text-sm text-ink-600">{group.summary}</p>
          {models.length > 1 ? (
            <Card className="mb-4">
              <CardBody>
                <GroupDiagram
                  dataModel={dataModel}
                  names={models.map((annotated) => annotated.model.name)}
                  title={`${group.title} entity-relationship diagram`}
                />
              </CardBody>
            </Card>
          ) : null}
          <div className="space-y-4">
            {models.map((annotated) => (
              <ModelCard key={annotated.model.name} annotated={annotated} />
            ))}
          </div>
        </section>
      ))}

      <section id="invariants" className="mb-10 scroll-mt-24">
        <h2 className="text-lg font-semibold text-ink-900">Invariants in the schema</h2>
        <p className="mb-4 max-w-4xl text-sm text-ink-600">
          The non-negotiable rules of the product, and where the data model carries them. A schema cannot
          enforce a rule on its own, so each row also names the code path that does — the column is
          the record, the code path is the control.
        </p>
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-xs">
              <thead className="bg-ink-50 text-left uppercase tracking-wide text-ink-500">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Invariant
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Carried by
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Enforced in
                  </th>
                </tr>
              </thead>
              <tbody>
                {INVARIANT_ANCHORS.map((anchor) => (
                  <tr key={anchor.invariant} className="border-t border-ink-100 align-top">
                    <th scope="row" className="px-4 py-2 text-left font-semibold text-ink-800">
                      {anchor.invariant}
                    </th>
                    <td className="px-3 py-2 text-ink-800">{anchor.claim}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-600">
                      {anchor.carriedBy.join(', ')}
                    </td>
                    <td className="px-3 py-2 text-ink-600">{anchor.enforcedIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>

      <section id="enumerations" className="mb-10 scroll-mt-24">
        <h2 className="text-lg font-semibold text-ink-900">Enumerations</h2>
        <p className="mb-4 max-w-4xl text-sm text-ink-600">
          SQLite has no enum type, so every enumerated column is a string validated by Zod. The
          permitted values live in one place in code and are listed here against the columns that
          hold them.
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ENUMERATIONS.map((enumeration) => (
            <Card key={enumeration.name} as="article">
              <CardBody>
                <h3 className="text-sm font-semibold text-ink-900">{enumeration.label}</h3>
                <p className="font-mono text-[11px] text-ink-500">{enumeration.columns.join(', ')}</p>
                <ul className="mt-2 flex flex-wrap gap-1">
                  {enumeration.values.map((value) => (
                    <li key={value}>
                      <Badge>{value}</Badge>
                    </li>
                  ))}
                </ul>
                {enumeration.note ? (
                  <p className="mt-2 text-xs text-ink-600">{enumeration.note}</p>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      <section id="payloads" className="mb-10 scroll-mt-24">
        <h2 className="text-lg font-semibold text-ink-900">Artifact payloads</h2>
        <p className="mb-4 max-w-4xl text-sm text-ink-600">
          <code>ArtifactVersion.contentJson</code> is opaque to the database on purpose: its shape is
          set by the artifact type, and each type has one Zod schema shared by the server action and
          the form. These are the {ARTIFACT_TYPES.length} types, in stage order.
        </p>
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full min-w-[820px] text-xs">
              <thead className="bg-ink-50 text-left uppercase tracking-wide text-ink-500">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    Stage
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Artifact
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Stored as
                  </th>
                  <th scope="col" className="px-3 py-2">
                    What it holds
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...ARTIFACT_TYPES]
                  .sort((a, b) => a.stage - b.stage)
                  .map((type) => (
                    <tr key={type.key} className="border-t border-ink-100 align-top">
                      <th scope="row" className="px-4 py-1.5 text-left font-medium text-ink-800">
                        {type.stage}
                      </th>
                      <td className="px-3 py-1.5 text-ink-800">
                        <Link href={`/academy/stage-${type.stage}`} className="text-accent-600 hover:underline">
                          {type.title}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-ink-600">
                        {type.fileName}
                      </td>
                      <td className="px-3 py-1.5 text-ink-600">{type.description}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>
    </div>
  )
}
