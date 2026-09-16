Feature: A concurrent writer's own S3 round-trip does not block other writers

  Reproduces moth s0f42: before the connection-hold-time fix, one writer
  doing several sequential inserts (each paying a real S3 upload) holds the
  single pooled connection for the full duration of every upload, so an
  unrelated concurrent writer's single insert queues behind all of them.
  After the fix, the concurrent writer only waits for local commits, not
  S3 round-trips.

  Background:
    Given a throwaway S3 bucket for this test run

  Scenario: A concurrent single-insert writer is not blocked by another writer's multi-insert burst
    Given a shared "events" table created by a bootstrap writer for the contention scenario
    When a burst writer starts inserting 14 rows into "events" one at a time, each via its own top-level statement
    And once the burst writer's first insert has committed locally, a concurrent writer inserts 1 row into "events"
    Then the concurrent writer's insert completes in under 3 seconds
    And all 15 rows eventually appear in "events" once the burst writer finishes
