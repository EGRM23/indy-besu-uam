// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

struct BenchmarkSchemaMetadata { uint256 created; }
struct BenchmarkSchemaRecord { bytes schema; BenchmarkSchemaMetadata metadata; }

interface IBenchmarkSchemaRegistry {
    function resolveSchema(bytes32 id) external view returns (BenchmarkSchemaRecord memory);
}

/// Compares an externally bridged VON reference with direct EVM registry resolution.
contract IntegrationRegistryBenchmark {
    event VonReferenceAccepted(bytes32 indexed schemaHash, address indexed caller);
    event IndySchemaResolved(bytes32 indexed schemaId, bytes32 indexed schemaHash, address indexed caller);

    function submitVonSchema(bytes32 schemaHash) external {
        emit VonReferenceAccepted(schemaHash, msg.sender);
    }

    function resolveIndySchema(address registry, bytes32 schemaId, bytes32 expectedSchemaHash) external {
        BenchmarkSchemaRecord memory record = IBenchmarkSchemaRegistry(registry).resolveSchema(schemaId);
        bytes32 actualSchemaHash = keccak256(record.schema);
        require(actualSchemaHash == expectedSchemaHash, "schema hash mismatch");
        emit IndySchemaResolved(schemaId, actualSchemaHash, msg.sender);
    }
}
