/** C5 runner using ten distinct, pre-authorized writers to avoid nonce coupling. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { keccak256, toUtf8Bytes, Wallet } from 'ethers'
import environment from '../environment'
import { ROLES } from '../contracts-ts'
import { Actor } from './utils/actor'

const RUN_ID = process.env.C5_RUN_ID || 'paper-c-qbft4'
const SCENARIO = process.env.C5_SCENARIO || 'unknown'
const REPEAT = process.env.C5_REPEAT || '0'
const TIMEOUT_MS = Number(process.env.C5_TIMEOUT_MS || '10000')
const resultDir = resolve(__dirname, '..', 'results', 'experiment_c', RUN_ID)
const fixturePath = resolve(resultDir, 'c5-writers.json')
const now = () => Number(process.hrtime.bigint()) / 1_000_000

function writerInfo(index: number) {
  const privateKey = keccak256(toUtf8Bytes(`${RUN_ID}-writer-${index}`))
  return { address: new Wallet(privateKey).address, privateKey }
}
function withTimeout<T>(p: Promise<T>) {
  let timer: NodeJS.Timeout
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`confirmation timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS) })]).finally(() => clearTimeout(timer!))
}
async function main() {
  mkdirSync(resultDir, { recursive: true })
  const trustee = await new Actor(environment.accounts.account1).init()
  const existingFixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : { writers: [] }
  const known = new Set<string>((existingFixture.writers || []).map((w: any) => w.address.toLowerCase()))
  const writers = [] as Actor[]
  for (let i = 1; i <= 30; i++) {
    const actor = await new Actor(writerInfo(i)).init()
    writers.push(actor)
    if (!known.has(actor.address.toLowerCase())) {
      await trustee.roleControl.assignRole(ROLES.ENDORSER, actor.address)
      try { await actor.didRegistry.resolveDid(actor.address) } catch (_) { await actor.didRegistry.createDid(actor.address, actor.didDocument) }
    }
  }
  writeFileSync(fixturePath, JSON.stringify({ writers: writers.map((w) => ({ address: w.address, did: w.did })) }, null, 2))
  if (process.env.C5_PREP_ONLY === 'true') {
    console.log(JSON.stringify({ prepared_writers: writers.length }, null, 2))
    return
  }
  const reader = trustee
  const reads: any[] = [], writes: any[] = []
  const offset = (Number(REPEAT) - 1) * 10
  const selected = writers.slice(offset, offset + 10)
  if (selected.length !== 10) throw new Error(`No writer group for repeat ${REPEAT}`)
  for (let i = 0; i < 10; i++) {
    const t = now()
    try { const r = await reader.didRegistry.resolveDid(selected[i].address); reads.push({ index: i + 1, success: r.document === selected[i].didDocument, latency_ms: now() - t, block_height: await reader.account.signer.provider!.getBlockNumber() }) }
    catch (e: any) { reads.push({ index: i + 1, success: false, latency_ms: now() - t, error: String(e.message || e) }) }
  }
  const writeTasks = selected.map(async (actor, i) => {
    const id = `${actor.did}/anoncreds/v0/SCHEMA/c5_availability/1.0/${RUN_ID}-${SCENARIO}-${REPEAT}-${i + 1}`
    const schema = JSON.stringify({ id, issuerId: actor.did, name: 'c5_availability', version: '1.0', attrNames: ['can_ride'] })
    const t = now()
    try { const receipt: any = await withTimeout(actor.schemaRegistry.createSchema(actor.address, id, actor.did, schema)); return { index: i + 1, success: receipt.status === 1, latency_ms: now() - t, tx_hash: receipt.hash, block_number: Number(receipt.blockNumber), gas_used: Number(receipt.gasUsed) } }
    catch (e: any) { return { index: i + 1, success: false, latency_ms: now() - t, error: String(e.message || e) } }
  })
  writes.push(...await Promise.all(writeTasks))
  const result = { scenario: SCENARIO, repeat: Number(REPEAT), timeout_ms: TIMEOUT_MS, reads, writes }
  writeFileSync(resolve(resultDir, `c5-${SCENARIO}-repeat-${REPEAT}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ scenario: SCENARIO, repeat: REPEAT, read_success: reads.filter((x) => x.success).length, write_success: writes.filter((x) => x.success).length }, null, 2))
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
