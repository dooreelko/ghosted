Feature: Multi-writer reconciliation and cold restore against real S3

  The sqlite-s3 storage layer is meant to support multiple concurrent
  writers, not just one, and to let a brand-new client see every
  writer's committed data after restarting with no local state. This
  suite proves both against a real S3 bucket, using simple standalone
  Knex clients (no Ghost involved) as the writers.

  Scenario: Three concurrent writers reconcile their commits, and a fresh client restores everything
    Given a throwaway S3 bucket for this test run
    And a shared "widgets" table created by a bootstrap writer
    When 3 concurrent writers each insert 8 rows into "widgets" via reconciling transactions
    Then all 24 rows are present, one per (writer, sequence) pair, with none lost or duplicated
    When a brand new client starts fresh with no local database and connects to the same bucket
    Then it sees all 24 rows in "widgets"
