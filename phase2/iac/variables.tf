variable "image_tag" {
  type        = string
  description = "Git short-SHA tag of the image to deploy (set via -var on each deploy)"
  # Only read when deploy_lightsail = true; the prereq-only apply has no image
  # to deploy yet, so it must not require a value there.
  default = ""

  validation {
    # deploy_lightsail defaults true now (routine, permanent state) -- an
    # apply that forgets -var image_tag would otherwise silently repoint the
    # live container at "<repo>:" and force a replacement. Caught here
    # rather than as a surprise container restart with a broken image.
    condition     = var.deploy_lightsail == false || var.image_tag != ""
    error_message = "image_tag is required (pass -var image_tag=<git-short-sha>) whenever deploy_lightsail = true."
  }
}

variable "deploy_lightsail" {
  type        = bool
  description = "Bring up the container service, its deployment, and the app-runtime IAM role. Defaults true: the Phase 1->2 migration (moth i8hlt) is complete and this is now the live, permanent state. Pass -var deploy_lightsail=false explicitly to get the prereqs-only stage (S3 data bucket, ECR repository) back."
  default     = true
}

variable "redeploy" {
  type        = bool
  description = "Cosmetic toggle to force a new Lightsail deployment version -- and therefore a real container restart -- without rebuilding the image or changing any functional config. Each transition (false->true or true->false) forces one restart; flip it, apply, then flip it back whenever you just want a fresh boot (e.g. to refresh the boot-time CloudWatch metrics)."
  default     = false
}

variable "marketing_root_oac_id" {
  type        = string
  description = "ID of the CloudFront Origin Access Control on the Phase 1 marketing-root S3 origin (not part of this state). No default -- see .local-secrets.md (\"Phase 2 CloudFront import\" heading) for the value, supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "marketing_root_origin_domain" {
  type        = string
  description = "S3 website/REST domain_name of the Phase 1 marketing-root origin (e.g. <bucket>.s3.<region>.amazonaws.com). No default -- the bucket name and region must not live in a tracked file. See .local-secrets.md (\"Phase 2 CloudFront import\" heading) for the value, supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "site_acm_certificate_arn" {
  type        = string
  description = "ARN of the ACM certificate the site distribution's viewer_certificate uses. No default -- kept out of a name-based data lookup deliberately (most_recent = true risks silently swapping the live certificate) and out of tracked files (the ARN embeds the account ID). See .local-secrets.md (\"Phase 2 CloudFront import\" heading), supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "deploy_cloudfront" {
  type        = bool
  description = "Point the CloudFront /blog* behaviours at Lightsail instead of the Phase 1 EC2 origin, and add the image behaviour. Was the one-time cutover switch (moth i8hlt, executed 2026-09-10); defaults true now that the cutover is complete and permanent -- every routine apply must keep matching live state (see phase2/readme.md's Design section for the incident this caused once). Locked true: the Phase 1 EC2 origin was deleted in the 2026-09-11 cost teardown, so there is no Phase 1 origin left to roll back to."
  default     = true

  validation {
    # Nothing to point at otherwise. Caught at plan time rather than as a
    # confusing provider error mid-apply.
    condition     = var.deploy_cloudfront == false || var.deploy_lightsail == true
    error_message = "deploy_cloudfront requires deploy_lightsail = true: there would be no Lightsail origin to point the behaviours at."
  }

  validation {
    # The Phase 1 EC2 origin block was removed from cloudfront.tf once the
    # underlying VPC origin was deleted (2026-09-11 cost teardown) -- so
    # deploy_cloudfront=false would point behaviours at an origin_id that no
    # longer exists in this config.
    condition     = var.deploy_cloudfront == true
    error_message = "deploy_cloudfront=false is no longer a valid rollback: the Phase 1 EC2 origin was deleted and its config block removed."
  }
}
