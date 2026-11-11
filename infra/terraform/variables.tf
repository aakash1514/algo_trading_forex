variable "region" {
  description = "AWS region for every resource."
  type        = string
  default     = "ap-south-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region name such as ap-south-1."
  }
}

variable "domain" {
  description = "The site's apex domain (Caddy's DOMAIN). Its A records are set at the registrar, not here."
  type        = string
  default     = "forexedge.tech"

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a lower-case hostname such as forexedge.tech."
  }
}

variable "github_repo" {
  description = "owner/name of the GitHub repository whose main branch may assume the deploy role."
  type        = string
  default     = "aakash1514/algo_trading_forex"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repo))
    error_message = "github_repo must be owner/name, with no wildcard."
  }
}

variable "alert_email" {
  description = "Address that receives the alarm notifications (SNS email subscription, confirmed by hand)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "instance_type" {
  description = "EC2 instance type of the single host."
  type        = string
  default     = "t3.medium"
}

variable "cpu_credits" {
  description = "T3 credit mode: standard (no surplus charges) or unlimited (only for the Phase 3 image pull and history import)."
  type        = string
  default     = "standard"

  validation {
    condition     = contains(["standard", "unlimited"], var.cpu_credits)
    error_message = "cpu_credits must be standard or unlimited."
  }
}

variable "instance_state" {
  description = "running, or stopped to pause the host between demos (docs/DEPLOY.md section 9): compute stops billing, the volume, Elastic IP and data stay."
  type        = string
  default     = "running"

  validation {
    condition     = contains(["running", "stopped"], var.instance_state)
    error_message = "instance_state must be running or stopped."
  }
}

variable "root_volume_gb" {
  description = "Size of the root gp3 volume in GiB (it also holds the database)."
  type        = number
  default     = 40

  validation {
    condition     = var.root_volume_gb >= 20 && floor(var.root_volume_gb) == var.root_volume_gb
    error_message = "root_volume_gb must be a whole number of at least 20."
  }
}

variable "enable_termination_protection" {
  description = "API termination protection on the instance. Turn off (and apply) only right before a destroy."
  type        = bool
  default     = true
}
