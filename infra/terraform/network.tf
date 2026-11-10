# A dedicated VPC with one public subnet: the host needs a public address for Caddy and outbound HTTPS
# (Let's Encrypt, ECR, SSM, CloudWatch), and nothing else. No NAT, no private subnet, no IPv6 CIDR.
resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "forexedge" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "forexedge" }
}

# No automatic public IPv4: the Elastic IP is the host's only public address (each one is billed)
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "forexedge-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "forexedge-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# The VPC's default security group, taken over with no rules, so nothing attached to it by mistake is open
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "forexedge-default-unused" }
}

# The host's only security group: HTTP and HTTPS (TCP, and UDP 443 for Caddy's HTTP/3) from anywhere.
# No SSH: shell access is Session Manager, which needs no inbound port. Rules are separate resources
# (never inline blocks) so each one is a plain, testable object.
resource "aws_security_group" "web" {
  name        = "forexedge-web"
  description = "ForexEdge host: HTTP and HTTPS in, everything out"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "forexedge-web" }
}

locals {
  web_ingress = {
    http_ipv4       = { protocol = "tcp", port = 80, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    http_ipv6       = { protocol = "tcp", port = 80, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
    https_ipv4      = { protocol = "tcp", port = 443, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    https_ipv6      = { protocol = "tcp", port = 443, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
    https_quic_ipv4 = { protocol = "udp", port = 443, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    https_quic_ipv6 = { protocol = "udp", port = 443, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
  }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = local.web_ingress

  security_group_id = aws_security_group.web.id
  description       = each.key
  ip_protocol       = each.value.protocol
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr_ipv4
  cidr_ipv6         = each.value.cidr_ipv6

  tags = { Name = "forexedge-${replace(each.key, "_", "-")}" }
}

resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.web.id
  description       = "all outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"

  tags = { Name = "forexedge-egress-all" }
}
