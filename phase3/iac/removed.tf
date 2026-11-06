# The container service is gone and Phase 2 owns the data bucket and the image
# repository in its own state. Phase 3 stops managing them but must never delete
# them: `destroy = false` only forgets them from this state. (Keep these blocks
# until the apply that forgets them has run; they are harmless afterwards.)

removed {
  from = aws_s3_bucket.data

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_s3_bucket_public_access_block.data

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ecr_repository.ghost

  lifecycle {
    destroy = false
  }
}
