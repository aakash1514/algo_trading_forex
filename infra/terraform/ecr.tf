# One private repository per image (forexedge/<image>, the names of infra/docker-compose.prod.yml; check.sh
# compares the two lists). Tags are immutable: IMAGE_TAG is a git commit, and a pushed commit never changes.
resource "aws_ecr_repository" "this" {
  for_each = local.images

  name                 = "forexedge/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# The last 5 images per repository: the running one plus four to roll back to
resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}
