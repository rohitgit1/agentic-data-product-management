-- ADPM — PostgreSQL DDL for all 35 tables.
--
-- GENERATED, not hand-maintained. Reproduce with:
--
--   pnpm db:pg:prepare
--   pnpm exec prisma migrate diff \
--     --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script
--
-- This file is here so a data engineer, a DBA or a reviewer can read the physical model without
-- running Prisma, and so non-Prisma tooling (schema comparison, IaC, catalogue registration) has
-- something to consume. It is NOT the deployment mechanism: schema changes reach an environment
-- through `prisma migrate deploy` run as a one-off administrative job, never by applying this file
-- by hand. See docs/build-spec/03-data-model.md §6.
--
-- Conventions carried from the canonical schema (see docs/adr/0004 and 0008):
--   * Enumerations are TEXT columns whose permitted values are defined once in
--     src/lib/domain/enums.ts and validated by Zod at the boundary. No native enum types.
--   * Structured payloads are TEXT columns named `*Json`, parsed at the boundary.
--   * ArtifactVersion, AuditEvent, AgentAction, AgentRunStep and ExternalMetadataImport are
--     append-only by contract. Nothing is hard-deleted; entities that leave circulation carry
--     `archivedAt`.
--   * Identifiers are application-generated CUIDs (TEXT), not database sequences.


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "packKey" TEXT NOT NULL,
    "triageSlaHours" INTEGER NOT NULL DEFAULT 48,
    "agentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "agentsMaySeeSampleData" BOOLEAN NOT NULL DEFAULT false,
    "agentBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "agentSpendUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prioritisationModel" TEXT NOT NULL DEFAULT 'WSJF_REUSE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "door" TEXT NOT NULL,
    "owns" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domainId" TEXT,
    "requesterId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "decision" TEXT NOT NULL DEFAULT '',
    "consumerRole" TEXT NOT NULL DEFAULT '',
    "peopleAffected" INTEGER NOT NULL DEFAULT 1,
    "cadence" TEXT NOT NULL DEFAULT '',
    "currentWorkaround" TEXT NOT NULL DEFAULT '',
    "timeTakenToday" TEXT NOT NULL DEFAULT '',
    "questionsJson" TEXT NOT NULL DEFAULT '[]',
    "stakes" TEXT NOT NULL DEFAULT '',
    "quantifiedImpact" TEXT NOT NULL DEFAULT '',
    "requiredFreshness" TEXT NOT NULL DEFAULT '',
    "preferredPatternKey" TEXT NOT NULL DEFAULT '',
    "sensitivityNotes" TEXT NOT NULL DEFAULT '',
    "submittedAt" TIMESTAMP(3),
    "slaDueAt" TIMESTAMP(3),
    "triagedAt" TIMESTAMP(3),
    "triagedById" TEXT,
    "declineReason" TEXT,
    "mergedIntoRequestId" TEXT,
    "mergedIntoProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ProductRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REPLY',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataProduct" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "requestId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "archetype" TEXT NOT NULL DEFAULT 'ENTITY_MASTER',
    "tier" TEXT NOT NULL DEFAULT 'CONSUMER_ALIGNED',
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "currentStage" INTEGER NOT NULL DEFAULT 1,
    "ownerId" TEXT NOT NULL,
    "stewardId" TEXT,
    "blueprintKey" TEXT,
    "semanticVersion" TEXT NOT NULL DEFAULT '0.1.0',
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "DataProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "number" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "StageRun" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "StageRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactVersion" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mirrorPath" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ArtifactVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldProvenance" (
    "id" TEXT NOT NULL,
    "artifactVersionId" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "agentId" TEXT,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "FieldProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gate" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "stageRunId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "quorum" INTEGER NOT NULL,
    "requiredRoles" TEXT NOT NULL,
    "vetoRoles" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "staleAt" TIMESTAMP(3),

    CONSTRAINT "Gate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateEvidence" (
    "id" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactVersionId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "GateEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "artifactId" TEXT,
    "fieldPath" TEXT,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REVIEW',
    "body" TEXT NOT NULL,
    "parentId" TEXT,
    "agentActionId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT,
    "requestId" TEXT,
    "gateId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "assigneeRoleKey" TEXT,
    "assigneeUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'HUMAN',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "raisedById" TEXT,
    "raisedByAgentId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "versionBump" TEXT NOT NULL DEFAULT 'PATCH',
    "affectedStages" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "dispositionById" TEXT,
    "dispositionAt" TIMESTAMP(3),
    "dispositionNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pack" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "contentJson" TEXT NOT NULL,
    "changeLogJson" TEXT NOT NULL DEFAULT '[]',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "Pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Blueprint" (
    "id" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archetype" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "contentJson" TEXT NOT NULL,

    CONSTRAINT "Blueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumptionPatternBinding" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "patternKey" TEXT NOT NULL,
    "targeted" BOOLEAN NOT NULL DEFAULT false,
    "readinessJson" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumptionPatternBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "patternKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValueMeasurement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "hypothesisJson" TEXT NOT NULL,
    "baseline" DOUBLE PRECISION,
    "measuredValue" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'NOT_YET_MEASURABLE',
    "dueAt" TIMESTAMP(3),
    "measuredAt" TIMESTAMP(3),
    "measuredById" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValueMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaturityAssessment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "scoresJson" TEXT NOT NULL,
    "notesJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaturityAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrioritisationOverride" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "overriddenById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrioritisationOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "autonomyLevel" TEXT NOT NULL DEFAULT 'L1',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalMetadataImport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "importedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalMetadataImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "autonomyLevel" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "productId" TEXT,
    "stageNumber" INTEGER,
    "trigger" TEXT NOT NULL,
    "scopeJson" TEXT NOT NULL DEFAULT '[]',
    "inputHash" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'none',
    "configuredModel" TEXT NOT NULL DEFAULT '',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outputJson" TEXT NOT NULL DEFAULT '{}',
    "redactedFieldsJson" TEXT NOT NULL DEFAULT '[]',
    "disposition" TEXT NOT NULL DEFAULT 'PENDING',
    "dispositionById" TEXT,
    "dispositionAt" TIMESTAMP(3),
    "dispositionNote" TEXT NOT NULL DEFAULT '',
    "initiatedById" TEXT,
    "orchestrationParentId" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL,
    "agentActionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "artifactId" TEXT,
    "stageNumber" INTEGER NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "proposedValueJson" TEXT NOT NULL,
    "acceptedValueJson" TEXT,
    "rationale" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "dispositionById" TEXT,
    "dispositionAt" TIMESTAMP(3),
    "dispositionNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'AUTOMATED',
    "state" TEXT NOT NULL DEFAULT 'RUNNING',
    "requestedModel" TEXT NOT NULL DEFAULT '',
    "contextSourcesJson" TEXT NOT NULL DEFAULT '[]',
    "fromStage" INTEGER NOT NULL DEFAULT 1,
    "toStage" INTEGER NOT NULL DEFAULT 12,
    "currentStage" INTEGER NOT NULL DEFAULT 1,
    "statusDetail" TEXT NOT NULL DEFAULT '',
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "agentId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "agentActionId" TEXT,
    "detail" TEXT NOT NULL DEFAULT '',
    "narrative" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_workspaceId_key_key" ON "Domain"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "RoleAssignment_workspaceId_roleId_idx" ON "RoleAssignment"("workspaceId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_userId_roleId_workspaceId_domainId_key" ON "RoleAssignment"("userId", "roleId", "workspaceId", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRequest_reference_key" ON "ProductRequest"("reference");

-- CreateIndex
CREATE INDEX "ProductRequest_workspaceId_state_idx" ON "ProductRequest"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "RequestMessage_requestId_idx" ON "RequestMessage"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "DataProduct_requestId_key" ON "DataProduct"("requestId");

-- CreateIndex
CREATE INDEX "DataProduct_workspaceId_status_idx" ON "DataProduct"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DataProduct_workspaceId_key_key" ON "DataProduct"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_key_key" ON "Stage"("key");

-- CreateIndex
CREATE INDEX "StageRun_productId_stageNumber_idx" ON "StageRun"("productId", "stageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StageRun_productId_stageNumber_attempt_key" ON "StageRun"("productId", "stageNumber", "attempt");

-- CreateIndex
CREATE INDEX "Artifact_productId_stageNumber_idx" ON "Artifact"("productId", "stageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_productId_type_key" ON "Artifact"("productId", "type");

-- CreateIndex
CREATE INDEX "ArtifactVersion_contentHash_idx" ON "ArtifactVersion"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactVersion_artifactId_version_key" ON "ArtifactVersion"("artifactId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FieldProvenance_artifactVersionId_fieldPath_key" ON "FieldProvenance"("artifactVersionId", "fieldPath");

-- CreateIndex
CREATE UNIQUE INDEX "Gate_stageRunId_key" ON "Gate"("stageRunId");

-- CreateIndex
CREATE INDEX "Gate_productId_stageNumber_idx" ON "Gate"("productId", "stageNumber");

-- CreateIndex
CREATE INDEX "Gate_state_idx" ON "Gate"("state");

-- CreateIndex
CREATE UNIQUE INDEX "GateEvidence_gateId_artifactId_key" ON "GateEvidence"("gateId", "artifactId");

-- CreateIndex
CREATE INDEX "Approval_gateId_idx" ON "Approval"("gateId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_gateId_userId_roleKey_key" ON "Approval"("gateId", "userId", "roleKey");

-- CreateIndex
CREATE INDEX "Comment_productId_stageNumber_idx" ON "Comment"("productId", "stageNumber");

-- CreateIndex
CREATE INDEX "Task_workspaceId_completedAt_idx" ON "Task"("workspaceId", "completedAt");

-- CreateIndex
CREATE INDEX "Task_assigneeRoleKey_idx" ON "Task"("assigneeRoleKey");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_productId_createdAt_idx" ON "AuditEvent"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ChangeRequest_productId_state_idx" ON "ChangeRequest"("productId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Pack_key_key" ON "Pack"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Blueprint_packId_key_key" ON "Blueprint"("packId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumptionPatternBinding_productId_patternKey_key" ON "ConsumptionPatternBinding"("productId", "patternKey");

-- CreateIndex
CREATE INDEX "AccessRequest_productId_state_idx" ON "AccessRequest"("productId", "state");

-- CreateIndex
CREATE INDEX "Feedback_productId_idx" ON "Feedback"("productId");

-- CreateIndex
CREATE INDEX "ValueMeasurement_productId_idx" ON "ValueMeasurement"("productId");

-- CreateIndex
CREATE INDEX "MaturityAssessment_workspaceId_createdAt_idx" ON "MaturityAssessment"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "PrioritisationOverride_productId_idx" ON "PrioritisationOverride"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSetting_workspaceId_agentId_key" ON "AgentSetting"("workspaceId", "agentId");

-- CreateIndex
CREATE INDEX "ExternalMetadataImport_productId_createdAt_idx" ON "ExternalMetadataImport"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModelAssignment_workspaceId_autonomyLevel_key" ON "ModelAssignment"("workspaceId", "autonomyLevel");

-- CreateIndex
CREATE INDEX "AgentAction_workspaceId_createdAt_idx" ON "AgentAction"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_agentId_idx" ON "AgentAction"("agentId");

-- CreateIndex
CREATE INDEX "AgentAction_productId_idx" ON "AgentAction"("productId");

-- CreateIndex
CREATE INDEX "AgentProposal_productId_stageNumber_state_idx" ON "AgentProposal"("productId", "stageNumber", "state");

-- CreateIndex
CREATE INDEX "AgentRun_productId_state_idx" ON "AgentRun"("productId", "state");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_startedAt_idx" ON "AgentRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRunStep_runId_stageNumber_idx" ON "AgentRunStep"("runId", "stageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunStep_runId_sequence_key" ON "AgentRunStep"("runId", "sequence");

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRequest" ADD CONSTRAINT "ProductRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRequest" ADD CONSTRAINT "ProductRequest_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRequest" ADD CONSTRAINT "ProductRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRequest" ADD CONSTRAINT "ProductRequest_triagedById_fkey" FOREIGN KEY ("triagedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestMessage" ADD CONSTRAINT "RequestMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProductRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestMessage" ADD CONSTRAINT "RequestMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataProduct" ADD CONSTRAINT "DataProduct_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataProduct" ADD CONSTRAINT "DataProduct_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataProduct" ADD CONSTRAINT "DataProduct_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProductRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataProduct" ADD CONSTRAINT "DataProduct_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataProduct" ADD CONSTRAINT "DataProduct_stewardId_fkey" FOREIGN KEY ("stewardId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageRun" ADD CONSTRAINT "StageRun_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldProvenance" ADD CONSTRAINT "FieldProvenance_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldProvenance" ADD CONSTRAINT "FieldProvenance_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gate" ADD CONSTRAINT "Gate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gate" ADD CONSTRAINT "Gate_stageRunId_fkey" FOREIGN KEY ("stageRunId") REFERENCES "StageRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateEvidence" ADD CONSTRAINT "GateEvidence_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "Gate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "Gate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProductRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "Gate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_dispositionById_fkey" FOREIGN KEY ("dispositionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Blueprint" ADD CONSTRAINT "Blueprint_packId_fkey" FOREIGN KEY ("packId") REFERENCES "Pack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionPatternBinding" ADD CONSTRAINT "ConsumptionPatternBinding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValueMeasurement" ADD CONSTRAINT "ValueMeasurement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValueMeasurement" ADD CONSTRAINT "ValueMeasurement_measuredById_fkey" FOREIGN KEY ("measuredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaturityAssessment" ADD CONSTRAINT "MaturityAssessment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaturityAssessment" ADD CONSTRAINT "MaturityAssessment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrioritisationOverride" ADD CONSTRAINT "PrioritisationOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrioritisationOverride" ADD CONSTRAINT "PrioritisationOverride_overriddenById_fkey" FOREIGN KEY ("overriddenById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSetting" ADD CONSTRAINT "AgentSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMetadataImport" ADD CONSTRAINT "ExternalMetadataImport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMetadataImport" ADD CONSTRAINT "ExternalMetadataImport_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAssignment" ADD CONSTRAINT "ModelAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_dispositionById_fkey" FOREIGN KEY ("dispositionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_agentActionId_fkey" FOREIGN KEY ("agentActionId") REFERENCES "AgentAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_dispositionById_fkey" FOREIGN KEY ("dispositionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DataProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunStep" ADD CONSTRAINT "AgentRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

