variable "image_tag" {
  type        = string
  description = "Git short-SHA tag of the image to deploy (set via -var on each deploy)"
  # Only read when deploy_lightsail = true; the prereq-only apply has no image
  # to deploy yet, so it must not require a value.
  default     = ""
}

variable "deploy_lightsail" {
  type        = bool
  description = "Bring up the container service, its deployment, and the app-runtime IAM role. With this false only the prereqs (S3 data bucket, ECR repository) exist."
  default     = false
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
