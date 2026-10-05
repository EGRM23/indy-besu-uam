/**
 * Reproducible measurements for paper experiment C (Indy-Besu SSI registry).
 *
 * Run from smart_contracts:
 *   npx hardhat run --network besu demos/experiment-c.ts
 * Optional: C_RUNS=30 C_RUN_ID=paper-c-YYYYMMDDTHHMMSSZ ...
 */
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { request } from 'http'
import environment from '../environment'
import { ROLES } from '../contracts-ts'
import { Actor } from './utils/actor'
import { createRevocationRegistryDefinitionObject, createRevocationRegistryEntryObject } from '../utils'

const RUNS = Number(process.env.C_RUNS || '30')
const RUN_ID = process.env.C_RUN_ID || `paper-c-${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}`
const SOURCE_CRED_DEF_ID = '5rtvexuq6mGGkvikxen2qK:3:CL:10:case-b'
const SOURCE_CRED_DEF_URL = `http://127.0.0.1:8131/credential-definitions/${SOURCE_CRED_DEF_ID}`

type Metric = Record<string, unknown>

function nowMs() { return Number(process.hrtime.bigint()) / 1_000_000 }
function jsonBytes(value: string) { return Buffer.byteLength(value, 'utf8') }

function percentile(values: number[], p: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function summary(rows: Metric[], fields: string[]) {
  const output: Record<string, unknown> = { runs: rows.length, successful: rows.filter((x) => x.success).length }
  for (const field of fields) {
    const values = rows.map((x) => x[field]).filter((x): x is number => typeof x === 'number')
    output[field] = values.length ? {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: percentile(values, 50), p95: percentile(values, 95), min: Math.min(...values), max: Math.max(...values),
    } : null
  }
  return output
}

function getJson(url: string): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method: 'GET', timeout: 20_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if ((res.statusCode || 500) >= 300) return reject(new Error(`GET ${url}: HTTP ${res.statusCode}: ${body.slice(0, 500)}`))
        try { resolvePromise(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`Timeout GET ${url}`)))
    req.on('error', reject)
    req.end()
  })
}

async function txMetric(actor: Actor, receipt: any, startMs: number, extra: Metric = {}): Promise<Metric> {
  const tx = await actor.account.signer.provider!.getTransaction(receipt.hash)
  return {
    ...extra,
    success: receipt.status === 1,
    tx_hash: receipt.hash,
    block_number: Number(receipt.blockNumber),
    gas_used: Number(receipt.gasUsed),
    calldata_bytes: tx?.data ? (tx.data.length - 2) / 2 : null,
    confirmation_ms: nowMs() - startMs,
  }
}

async function readMetric<T>(read: () => Promise<T>, expected: string, extract: (value: T) => string, extra: Metric = {}): Promise<Metric> {
  const start = nowMs()
  const value = await read()
  const actual = extract(value)
  return { ...extra, success: actual === expected, resolution_ms: nowMs() - start, content_equal: actual === expected }
}

async function ensureEndorser(trustee: Actor, actor: Actor) {
  const receipt = await trustee.roleControl.assignRole(ROLES.ENDORSER, actor.address)
  if (receipt.status !== 1) throw new Error(`Could not assign ENDORSER to ${actor.address}`)
  return { tx_hash: receipt.hash, block_number: Number(receipt.blockNumber), gas_used: Number(receipt.gasUsed) }
}

async function main() {
  if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error('C_RUNS must be a positive integer')
  const resultDir = resolve(__dirname, '..', 'results', 'experiment_c', RUN_ID)
  mkdirSync(resultDir, { recursive: true })
  const trustee = await new Actor(environment.accounts.account1).init()
  const sourceCredentialDefinition = (await getJson(SOURCE_CRED_DEF_URL)).credential_definition
  const sourceCredDefJson = JSON.stringify(sourceCredentialDefinition)

  // Setup: issuer used for schemas, credential definitions, and revocation registries.
  const issuer = await new Actor().init()
  const issuerRole = await ensureEndorser(trustee, issuer)
  const issuerDidStart = nowMs()
  const issuerDidReceipt = await issuer.didRegistry.createDid(issuer.address, issuer.didDocument)
  const issuerDidSetup = await txMetric(issuer, issuerDidReceipt, issuerDidStart, { did: issuer.did })
  if (!issuerDidSetup.success) throw new Error('Issuer DID setup transaction failed')

  const c1Write: Metric[] = [], c1Read: Metric[] = []
  for (let i = 0; i < RUNS; i++) {
    const actor = await new Actor().init()
    const role = await ensureEndorser(trustee, actor)
    const document = actor.didDocument
    const start = nowMs()
    const receipt = await actor.didRegistry.createDid(actor.address, document)
    c1Write.push(await txMetric(actor, receipt, start, { index: i + 1, did: actor.did, role_assignment: role }))
    c1Read.push(await readMetric(() => actor.didRegistry.resolveDid(actor.address), document, (value: any) => value?.document || '', { index: i + 1, did: actor.did }))
  }

  const schemas: { id: string, json: string }[] = []
  const c2Write: Metric[] = [], c2Read: Metric[] = []
  for (let i = 0; i < RUNS; i++) {
    const id = `${issuer.did}/anoncreds/v0/SCHEMA/user_credential/2.0/${RUN_ID}-${String(i + 1).padStart(2, '0')}`
    const schema = JSON.stringify({ id, issuerId: issuer.did, name: 'user_credential', version: '2.0', attrNames: ['fecha_nacimiento', 'nombres', 'can_ride', 'apellidos'] })
    const start = nowMs()
    const receipt = await issuer.schemaRegistry.createSchema(issuer.address, id, issuer.did, schema)
    c2Write.push(await txMetric(issuer, receipt, start, { index: i + 1, schema_id: id, json_bytes: jsonBytes(schema) }))
    c2Read.push(await readMetric(() => issuer.schemaRegistry.resolveSchema(id), schema, (value) => value.schema, { index: i + 1, schema_id: id }))
    schemas.push({ id, json: schema })
  }

  const credDefs: { id: string, schemaId: string, payload: string }[] = []
  const c3Write: Metric[] = [], c3Read: Metric[] = []
  for (let i = 0; i < RUNS; i++) {
    const schemaId = schemas[i].id
    const id = `${issuer.did}/anoncreds/v0/CLAIM_DEF/${RUN_ID}-${String(i + 1).padStart(2, '0')}`
    // Preserve the real VON-issued CL payload byte-for-byte. The registry relation to
    // the Indy-Besu schema is the schemaId argument of the registry call.
    const start = nowMs()
    const receipt = await issuer.credentialDefinitionRegistry.createCredentialDefinition(issuer.address, id, issuer.did, schemaId, sourceCredDefJson)
    c3Write.push(await txMetric(issuer, receipt, start, {
      index: i + 1, credential_definition_id: id, schema_id: schemaId, json_bytes: jsonBytes(sourceCredDefJson),
      source_credential_definition_id: SOURCE_CRED_DEF_ID, cl_type: sourceCredentialDefinition.type,
      has_cl_primary_key: Boolean(sourceCredentialDefinition.value?.primary),
    }))
    c3Read.push(await readMetric(() => issuer.credentialDefinitionRegistry.resolveCredentialDefinition(id), sourceCredDefJson, (value) => value.credDef, {
      index: i + 1, credential_definition_id: id, schema_id: schemaId,
      payload_references_von_schema: sourceCredentialDefinition.schemaId,
      has_cl_primary_key: Boolean(sourceCredentialDefinition.value?.primary),
    }))
    credDefs.push({ id, schemaId, payload: sourceCredDefJson })
  }

  const c4DefinitionWrite: Metric[] = [], c4ActiveRead: Metric[] = [], c4ActiveWrite: Metric[] = [], c4RevokedWrite: Metric[] = [], c4RevokedRead: Metric[] = []
  for (let i = 0; i < RUNS; i++) {
    const credDef = credDefs[i]
    const { id, revRegDef } = createRevocationRegistryDefinitionObject({ issuerId: issuer.did, credDefId: credDef.id, tag: `${RUN_ID}-${String(i + 1).padStart(2, '0')}` })
    let start = nowMs()
    let receipt = await issuer.revocationRegistry.createRevocationRegistryDefinition(issuer.address, id, credDef.id, issuer.did, revRegDef)
    c4DefinitionWrite.push(await txMetric(issuer, receipt, start, { index: i + 1, revocation_registry_id: id, credential_definition_id: credDef.id, json_bytes: jsonBytes(revRegDef) }))

    const active = createRevocationRegistryEntryObject({ revRegDefId: id, issued: [i + 1], revoked: [] }).revRegEntry
    start = nowMs()
    receipt = await issuer.revocationRegistry.createRevocationRegistryEntry(issuer.address, id, issuer.did, active)
    c4ActiveWrite.push(await txMetric(issuer, receipt, start, { index: i + 1, revocation_registry_id: id, state: 'active', json_bytes: jsonBytes(active) }))
    c4ActiveRead.push(await readMetric(() => issuer.revocationRegistry.fetchAllRevocationEntries(id), active, (value) => value[value.length - 1] || '', { index: i + 1, revocation_registry_id: id, expected_state: 'active' }))

    const revoked = createRevocationRegistryEntryObject({ revRegDefId: id, issued: [], revoked: [i + 1] }).revRegEntry
    start = nowMs()
    receipt = await issuer.revocationRegistry.createRevocationRegistryEntry(issuer.address, id, issuer.did, revoked)
    c4RevokedWrite.push(await txMetric(issuer, receipt, start, { index: i + 1, revocation_registry_id: id, state: 'revoked', json_bytes: jsonBytes(revoked) }))
    c4RevokedRead.push(await readMetric(() => issuer.revocationRegistry.fetchAllRevocationEntries(id), revoked, (value) => value[0] || '', { index: i + 1, revocation_registry_id: id, expected_state: 'revoked' }))
  }

  const raw = { protocol: 'experiment_c_v1', run_id: RUN_ID, runs: RUNS, environment: { rpc: environment.besu.rpcnode.url, chain_id: 1337, validators_expected: 5, source_cred_def_id: SOURCE_CRED_DEF_ID }, setup: { issuer_did: issuer.did, issuer_role: issuerRole, issuer_did_transaction: issuerDidSetup }, c1: { writes: c1Write, reads: c1Read }, c2: { writes: c2Write, reads: c2Read }, c3: { writes: c3Write, reads: c3Read, source_cred_def_preserved_bytes: sourceCredDefJson }, c4: { definition_writes: c4DefinitionWrite, active_writes: c4ActiveWrite, active_reads: c4ActiveRead, revoked_writes: c4RevokedWrite, revoked_reads: c4RevokedRead } }
  const summaries = {
    c1: { write: summary(c1Write, ['confirmation_ms', 'gas_used', 'calldata_bytes']), read: summary(c1Read, ['resolution_ms']) },
    c2: { write: summary(c2Write, ['confirmation_ms', 'gas_used', 'calldata_bytes', 'json_bytes']), read: summary(c2Read, ['resolution_ms']) },
    c3: { write: summary(c3Write, ['confirmation_ms', 'gas_used', 'calldata_bytes', 'json_bytes']), read: summary(c3Read, ['resolution_ms']) },
    c4: { definition_write: summary(c4DefinitionWrite, ['confirmation_ms', 'gas_used', 'calldata_bytes', 'json_bytes']), active_write: summary(c4ActiveWrite, ['confirmation_ms', 'gas_used', 'calldata_bytes', 'json_bytes']), active_read: summary(c4ActiveRead, ['resolution_ms']), revoked_write: summary(c4RevokedWrite, ['confirmation_ms', 'gas_used', 'calldata_bytes', 'json_bytes']), revoked_read: summary(c4RevokedRead, ['resolution_ms']) },
  }
  writeFileSync(resolve(resultDir, 'raw.json'), JSON.stringify(raw, null, 2))
  writeFileSync(resolve(resultDir, 'summary.json'), JSON.stringify(summaries, null, 2))
  console.log(JSON.stringify({ result_dir: resultDir, summaries }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
