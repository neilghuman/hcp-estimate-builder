# Session: FluentCRM Inbound Email Reply System — Planning & Architecture Design

**Date:** 2026-08-15  
**Status:** ✅ Planning complete, ready for sprint execution  
**Objective:** Design comprehensive inbound email reply filtering system for 140k+ recipient campaigns

---

## Overview

Designed a complete end-to-end system to prevent thousands of automated replies (out-of-office, NDR, spam) from flooding the support inbox when FluentCRM campaigns reach 140,000+ recipients.

**Key Innovation:** Deterministic rule-based classification (Layer 1, no AI needed for obvious cases) + optional AI fallback (Layer 2, only for uncertain messages).

---

## Deliverables

### 1. Architecture Document: `FLUENTCRM_EMAIL_REPLY_SYSTEM.md`
- **Section A:** Current-state assessment (existing FluentCRM, SES, n8n, Chatwoot, PostgreSQL)
- **Section B:** Proposed architecture (inbound pipeline design, safety mechanisms)
- **Section C:** AWS infrastructure (SES, S3, SNS, IAM, DNS)
- **Section D:** n8n workflow blueprint (15-node detailed flow with error handling)
- **Section E:** FluentCRM integration (unsubscribe detection + idempotent updates)
- **Section F:** Support integration (Chatwoot routing, metadata preservation)
- **Section G:** Failure & retry design (graceful degradation, recovery mechanisms)
- **Section H:** Test plan (20 scenarios: human reply, OOO, NDR, spam, prompt injection, load testing)
- **Section I:** Deployment plan (7-stage rollout with go/no-go gates)

**Size:** ~44 KB, 90 pages  
**Use Case:** Reference document for implementation, review, and compliance

### 2. Sprint Plan: `FLUENTCRM_EMAIL_REPLY_SPRINTS.md`
- **S1:** Inspection & Schema Design (1 week)
  - Confirm FluentCRM API access
  - Verify SES bounce handling (read-only)
  - Design PostgreSQL schema
  - Set up dev environment
- **S2:** Infrastructure Setup (1–2 weeks)
  - Create AWS resources (SES, S3, SNS, IAM)
  - Migrate database schema
  - Configure n8n credentials
- **S3:** Rule-Based Classification (1–2 weeks)
  - MIME parser
  - Deterministic rules (OOO, NDR, unsubscribe, spam)
  - Message preservation + error handling
- **S4:** AI Classification (1–2 weeks, optional)
  - Ollama integration (qwen2.5:7b)
  - Safety guardrails
  - Fallback behavior
- **S5:** FluentCRM Integration (1 week)
  - Unsubscribe detection + idempotent updates
  - Audit trail
- **S6:** Support Routing (1–2 weeks)
  - Chatwoot contact/conversation management
  - Metadata preservation
  - Duplicate prevention
- **S7:** Monitoring & Recovery (1 week)
  - Metrics dashboard
  - Alerting + failure recovery
  - On-call runbook
- **S8:** Production Deployment (2 weeks)
  - Canary testing (internal + small campaign)
  - Staged rollout (50% → 100%)
  - Week 1 monitoring

**Total Timeline:** 9–13 weeks (fast-track to conservative)  
**Use Case:** Execution roadmap for engineering team

---

## Key Architecture Decisions

### 1. Safety-First Design
- **Zero message loss:** Every email preserved to S3 + PostgreSQL before any processing
- **Idempotent:** Duplicate Message-IDs never create duplicate support tickets
- **Reversible:** Disable SNS subscription → system stops, messages remain in S3 for replay
- **Non-invasive:** Does NOT touch existing SES bounce handling (completely separate)

### 2. Deterministic-First Classification
1. **Layer 1 (Rules, no LLM needed):**
   - Out-of-office detection (headers: Auto-Submitted, X-Autoreply; keywords: vacation, away, responder)
   - NDR/mailer-daemon detection (MIME: multipart/report; senders: postmaster, mailer-daemon; headers: Delivery-Status-Notification)
   - Unsubscribe detection (keywords: unsubscribe, remove me, take me off list, stop emailing — conservative to avoid false negatives)
   - Spam detection (known domains, URL patterns)
2. **Layer 2 (AI fallback, only if Layer 1 uncertain):**
   - Ollama qwen2.5:7b
   - Structured JSON output with confidence scores
   - Safety: input truncation, output validation, prompt injection prevention
3. **Layer 3 (Manual review):**
   - Confidence < 0.70 → review queue for human triage

### 3. Message Preservation
- **S3:** Raw MIME files (forever), encrypted, lifecycle policy (Glacier after 90d, delete after 3y)
- **PostgreSQL:** Structured metadata (message_id, from, to, subject, classification, routing_decision, timestamps)
- **Guarantee:** All data stored before any external API calls (Chatwoot, FluentCRM, Ollama)

### 4. Routing Logic
```
Human Reply / Customer Question / Estimate Request
  ↓
Chatwoot Support Inbox (existing path, no changes)

Unsubscribe Request
  ↓
Update FluentCRM (idempotent) + Archive

OOO / Automated / NDR / Spam / Garbage
  ↓
Archive (30-day retention)

Uncertain (confidence < 0.70)
  ↓
Review Queue (manual triage)
```

### 5. FluentCRM Integration
- **Unsubscribe Detection:** Regex on email body (high precision, conservative keyword matching)
- **Confidence Threshold:** Only update if classification confidence >= 0.85
- **Idempotent:** WHERE status != 'unsubscribed' prevents double-updates
- **Audit Trail:** Every update logged to PG (fluentcrm_contact_id, fluentcrm_action_taken, fluentcrm_updated_at)

### 6. n8n Workflow
15-node workflow:
1. Webhook (SNS trigger)
2. Parse SNS + fetch S3 MIME
3. Parse MIME headers/body/attachments
4. Store to PG (idempotent on message_id)
5. Layer 1: Rule-based classification
6. Layer 2: AI classification (if needed)
7. Route based on classification
8. Update PG with routing_decision
9. Error handling (log failures, queue for retry)
+ Retry workflow (exponential backoff, max 3 retries)
+ Review queue processor (scheduled)
+ Metrics aggregation (hourly dashboard)

---

## AWS Resources Required

| Resource | Purpose | Details |
|----------|---------|---------|
| SES Domain | Inbound receiver | `mailer.unitedservicesnorthwest.com` with DKIM/SPF/DMARC |
| SES Inbound Rule | Route to S3+SNS | Triggers on `replies@mailer.unitedservicesnorthwest.com` |
| S3 Bucket | MIME storage | `campaign-inbound-replies/emails/`, encrypted, versioned |
| S3 Lifecycle | Archive policy | Glacier after 90d, delete after 3 years |
| SNS Topic | n8n trigger | `campaign-replies-inbound`, HTTPS webhook to n8n |
| IAM Role | n8n permissions | `n8n-campaign-processor` with S3 read + SNS read |

**Setup Time:** < 1 hour (AWS is largely unchanged from existing infrastructure)

---

## Existing Infrastructure Leverage

✅ **n8n** (10.0.10.25) — proven workflow automation  
✅ **Chatwoot** (10.0.10.102) — support system with API  
✅ **PostgreSQL** (10.0.30.10) — comms database  
✅ **Ollama LLM** (192.168.1.8:11434) — available for classification  
✅ **AWS SES** — already in use for outbound  
✅ **Proven patterns** — Yelp, Thumbtack, Google LSA all use similar routing

**No changes needed to existing bounce handling, FluentCRM sending, or Chatwoot infrastructure.**

---

## Testing Strategy

### Pre-Production (S3–S7)
- **Unit tests:** MIME parsing, classification rules, idempotency
- **Integration tests:** S3 + SNS + PG + Chatwoot + FluentCRM
- **End-to-end tests:** 20 scenarios (human, OOO, NDR, spam, prompt injection, load)
- **Load test:** 1,000 emails simulating 140k campaign burst

### Canary (S8 Phase 1)
- Internal team + 5 QA addresses
- All message types verified manually
- Chatwoot UI review + support team sign-off

### Canary Phase 2 (S8)
- Real campaign to 5,000 recipients
- 24-hour monitoring (metrics, alerts, support feedback)

### Production (S8 Phase 3+)
- 50% rollout (70k recipients) → 24h monitoring
- 100% rollout (140k recipients) → 7-day on-call coverage

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| FluentCRM API unavailable | Unsubscribes delayed | Retry workflow + queue mechanism |
| Chatwoot rate-limited | Support inbox lag | Backoff + queue, alert on excessive failures |
| SES inbound misconfigured | Emails not reaching S3 | Test before launch, verify in canary |
| MIME parser failure | Message loss or misclassification | Comprehensive tests, quarantine errors |
| Classification false positives | OOO/NDR in support inbox | Conservative thresholds, manual review queue |
| LLM prompt injection | AI hijacked by email content | Input sanitization, output validation |
| PG slowness | Processing latency | Load test, add indexes as needed |
| Post-launch issue | System needs emergency stop | One-click disable (SNS subscription toggle) |

---

## Questions for User (Before S1 Execution)

1. **FluentCRM Access:** API endpoint or database access for unsubscribe?
2. **SES Bounce Handling:** Current flow (SNS → FluentCRM?) — what must we NOT change?
3. **Chatwoot Inbox:** New "Campaign Replies" inbox or existing?
4. **Reply-To Address:** One address for all brands or per-brand?
5. **Timeline:** Aggressive (9w), Safe (11w), or Conservative (13w)?
6. **First Campaign:** When is the first real campaign expected?

---

## Next Steps

### For Review
- [ ] Architecture doc (`FLUENTCRM_EMAIL_REPLY_SYSTEM.md`) review
- [ ] Sprint plan (`FLUENTCRM_EMAIL_REPLY_SPRINTS.md`) review
- [ ] Questions answered (5 items above)

### For S1 Execution (Once Approved)
- [ ] Confirm FluentCRM API/database method
- [ ] Verify SES bounce handling (read-only)
- [ ] Assign Chatwoot inbox
- [ ] Set up development environment
- [ ] Design PostgreSQL schema

---

## Success Criteria (End of S8)

- **System Availability:** > 99% uptime
- **Message Preservation:** 100% (zero lost)
- **Classification Accuracy:** > 95% on obvious cases
- **Processing Latency:** < 10 seconds (p99)
- **Support Inbox Quality:** < 10% false positives (OOO/NDR/spam)
- **Unsubscribe Honor Rate:** 100% within 24 hours
- **Chatwoot Stability:** < 1% message posting failures
- **On-Call Confidence:** Team confident in runbook, < 1 hour issue resolution

---

## Appendix: Key Design Rationales

### Why Deterministic Rules First?
- Fast (no LLM latency)
- Observable (clear logs: "matched OOO header", "matched NDR mime type")
- Reliable (no hallucination risk)
- Cost-effective (no AI API calls)
- For 99% of cases (OOO, NDR), rules are sufficient

### Why PostgreSQL comms Schema?
- Existing infrastructure (already has comms tables)
- Audit trail (all actions logged)
- Queryable (support team can search by classification, routing, date)
- Retention (30-day configurable archive before S3 cleanup)

### Why S3 for Raw MIME?
- Cheap long-term storage
- Immutable (audit-friendly)
- Encrypted (security)
- Lifecycle policies (auto-archive/delete)
- Never lose a customer email (recovery from any failure)

### Why SNS → n8n (not Lambda)?
- Reuses existing n8n infrastructure
- Workflows version-controlled + testable
- Team familiar with n8n patterns (Yelp, Thumbtack, Google LSA all here)
- No additional infrastructure (Lambda + Python + deployment complexity)

### Why Chatwoot (not new system)?
- Existing support system
- Team already trained
- Metadata-rich conversations
- API well-tested
- Preserves existing support workflows

---

## Session Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|--------------------------|
| **Reply-To address** | `replies@mailer.unitedservicesnorthwest.com` | Per-brand addresses (decided unified for MVP) |
| **Classification layers** | Rules + optional AI | All AI (decided rules sufficient + cheaper) |
| **Message storage** | S3 + PG | Only PG (S3 needed for long-term retention) |
| **Idempotency key** | Message-ID | Hash of (from, to, subject, date) — decided Message-ID is standard |
| **Support inbox** | New "Campaign Replies" | Existing inbox (decided separate for clarity) |
| **Rollback mechanism** | Disable SNS subscription | Database rollback (decided SNS simpler + no data loss) |
| **AI model** | Ollama qwen2.5:7b | GPT-4 (decided on-prem to avoid API dependency) |
| **Retention policy** | 30 days | 7 / 60 / 90 (decided 30d balances audit trail + cost) |

---

## Document Locations

- **Architecture:** `./FLUENTCRM_EMAIL_REPLY_SYSTEM.md`
- **Sprints:** `./FLUENTCRM_EMAIL_REPLY_SPRINTS.md`
- **Session (this):** `./docs/sessions/feature-fluentcrm-email-reply-planning.md`

