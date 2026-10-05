import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { request } from 'http'
import { ethers } from 'hardhat'
import { JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes } from 'ethers'
import environment from '../environment'

const RUNS = Number(process.env.INTEGRATION_RUNS || '30')
const RUN_ID = process.env.INTEGRATION_RUN_ID || `integration-c-${new Date().toISOString().replace(/[-:.]/g, '')}`
const resultDir = resolve(__dirname, '..', 'results', 'experiment_c', RUN_ID)
const indyRaw = JSON.parse(readFileSync(resolve(__dirname, '..', 'results', 'experiment_c', 'paper-c-20261005T154000Z', 'raw.json'), 'utf8'))
const vonRaw = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'SSI_App', 'agents', 'case_c', 'results', 'paper-von-c-20261005T171000Z', 'raw.json'), 'utf8'))
const indySchemaId = indyRaw.c2.reads[0].schema_id
const vonSchemaId = vonRaw.c2.reads[0].schema_id
const schemaRegistryAddress = '0x0000000000000000000000000000000000005555'
const schemaAbi = ['function resolveSchema(bytes32) view returns (tuple(bytes schema, tuple(uint256 created) metadata))']
const now = () => Number(process.hrtime.bigint()) / 1_000_000

function getJson(url: string): Promise<any> { return new Promise((ok, fail) => { const r=request(url,{timeout:20000},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{try { if((res.statusCode||500)>=300) throw new Error(`HTTP ${res.statusCode}`); ok(JSON.parse(b)) } catch(e){fail(e)} })});r.on('error',fail);r.on('timeout',()=>r.destroy(new Error('timeout')));r.end() }) }
function pct(xs:number[], p:number) { const a=[...xs].sort((x,y)=>x-y); return a[Math.min(a.length-1, Math.ceil(a.length*p/100)-1)] }
function summarize(rows:any[]) { const fields=['http_lookup_ms','confirmation_ms','end_to_end_ms','gas_used']; const out:any={runs:rows.length,successful:rows.filter(r=>r.success).length}; for(const f of fields){const xs=rows.map(r=>r[f]).filter((x:any)=>typeof x==='number');out[f]=xs.length?{mean:xs.reduce((a:number,b:number)=>a+b,0)/xs.length,p50:pct(xs,50),p95:pct(xs,95),min:Math.min(...xs),max:Math.max(...xs)}:null} return out }

async function main() {
  mkdirSync(resultDir,{recursive:true})
  const provider=new JsonRpcProvider(environment.besu.rpcnode.url)
  const signer=new Wallet(environment.accounts.account1.privateKey,provider)
  const factory=await ethers.getContractFactory('IntegrationRegistryBenchmark',signer)
  const benchmark=await factory.deploy(); await benchmark.waitForDeployment()
  const registry=new Contract(schemaRegistryAddress,schemaAbi,provider)
  const indyRecord=await registry.resolveSchema(keccak256(toUtf8Bytes(indySchemaId)))
  const indySchemaHash=keccak256(indyRecord.schema)
  // Each route is a burst of independent requests with explicit sequential nonces.
  // This retains 30 observations while finishing before the execution environment
  // terminates a long, strictly serial (one-block-per-request) benchmark.
  const vonRows:any[]=[]; const indyRows:any[]=[]
  const vonNonce=await signer.getNonce('pending')
  const vonPrepared=await Promise.all(Array.from({length:RUNS},async (_,offset)=>{
    const index=offset+1; const all=now(); const t=now()
    const payload=await getJson(`http://127.0.0.1:8131/schemas/${encodeURIComponent(vonSchemaId)}`)
    return {index,all,lookup:now()-t,hash:keccak256(toUtf8Bytes(JSON.stringify(payload.schema)))}
  }))
  const vonSent:any[]=[]
  for (const row of vonPrepared) {
    const sent=now(); const tx=await benchmark.submitVonSchema(row.hash,{nonce:vonNonce+row.index-1})
    vonSent.push({...row,sent,tx})
  }
  vonRows.push(...await Promise.all(vonSent.map(async row=>{const rc=await row.tx.wait();return {index:row.index,success:rc?.status===1,http_lookup_ms:row.lookup,confirmation_ms:now()-row.sent,end_to_end_ms:now()-row.all,gas_used:Number(rc?.gasUsed),tx_hash:row.tx.hash,block_number:Number(rc?.blockNumber)}})))
  const indyNonce=await signer.getNonce('pending')
  const indySent:any[]=[]
  for(let offset=0;offset<RUNS;offset++) {
    const all=now(); const tx=await benchmark.resolveIndySchema(schemaRegistryAddress,keccak256(toUtf8Bytes(indySchemaId)),indySchemaHash,{nonce:indyNonce+offset})
    indySent.push({index:offset+1,all,tx})
  }
  indyRows.push(...await Promise.all(indySent.map(async row=>{const rc=await row.tx.wait();return {index:row.index,success:rc?.status===1,http_lookup_ms:null,confirmation_ms:now()-row.all,end_to_end_ms:now()-row.all,gas_used:Number(rc?.gasUsed),tx_hash:row.tx.hash,block_number:Number(rc?.blockNumber)}})))
  const raw={run_id:RUN_ID,runs:RUNS,contract:await benchmark.getAddress(),indy_schema_id:indySchemaId,von_schema_id:vonSchemaId,von_bridge:vonRows,indy_direct:indyRows}
  const summary={von_bridge:summarize(vonRows),indy_direct:summarize(indyRows)}
  writeFileSync(resolve(resultDir,'integration_raw.json'),JSON.stringify(raw,null,2));writeFileSync(resolve(resultDir,'integration_summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({result_dir:resultDir,summary},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
