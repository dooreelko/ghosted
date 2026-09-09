variable "image_tag" {
  type        = string
  description = "Git short-SHA tag of the image to deploy (set via -var on each deploy)"
  # Only read when deploy_lightsail = true; the prereq-only apply has no image
  # to deploy yet, so it must not require a value.
  default = ""
}

variable "deploy_lightsail" {
  type        = bool
  description = "Bring up the container service, its deployment, and the app-runtime IAM role. With this false only the prereqs (S3 data bucket, ECR repository) exist."
  default     = false
}

variable "vpc_origin_id" {
  type        = string
  description = "ID of the CloudFront VPC origin that targets the Phase 1 EC2 appserver. No default -- see .local-secrets.md (\"Phase 2 CloudFront import\" heading) for the value, supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "appserver_private_dns" {
  type        = string
  description = "Private DNS name of the Phase 1 EC2 appserver instance, used as the VPC-origin domain_name. No default -- see .local-secrets.md (\"Phase 2 CloudFront import\" heading) for the value, supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "marketing_root_oac_id" {
  type        = string
  description = "ID of the CloudFront Origin Access Control on the Phase 1 marketing-root S3 origin (not part of this state). No default -- see .local-secrets.md (\"Phase 2 CloudFront import\" heading) for the value, supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "site_acm_certificate_arn" {
  type        = string
  description = "ARN of the ACM certificate the site distribution's viewer_certificate uses. No default -- kept out of a name-based data lookup deliberately (most_recent = true risks silently swapping the live certificate) and out of tracked files (the ARN embeds the account ID). See .local-secrets.md (\"Phase 2 CloudFront import\" heading), supplied via the gitignored phase2/iac/phase1.auto.tfvars."
}

variable "deploy_cloudfront" {
  type        = bool
  description = "Point the CloudFront /blog* behaviours at Lightsail instead of the Phase 1 EC2 origin, and add the image behaviour. This is the cutover switch."
  default     = false

  validation {
    # Nothing to point at otherwise. Caught at plan time rather than as a
    # confusing provider error mid-apply.
    condition     = var.deploy_cloudfront == false || var.deploy_lightsail == true
    error_message = "deploy_cloudfront requires deploy_lightsail = true: there would be no Lightsail origin to point the behaviours at."
  }
}
