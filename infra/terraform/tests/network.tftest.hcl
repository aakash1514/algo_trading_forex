# The security group (Group C): HTTP/HTTPS only, from anywhere; never SSH.
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "web_only_ingress" {
  assert {
    condition = alltrue([for r in aws_vpc_security_group_ingress_rule.web :
    r.security_group_id == aws_security_group.web.id && r.from_port == r.to_port && contains([80, 443], r.from_port)])
    error_message = "Every ingress rule must open exactly one port, 80 or 443."
  }

  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.web : !(r.from_port <= 22 && r.to_port >= 22) && r.ip_protocol != "-1"])
    error_message = "No ingress rule may cover port 22 or all protocols."
  }

  assert {
    condition = toset([for r in aws_vpc_security_group_ingress_rule.web : "${r.ip_protocol}/${r.from_port}/${coalesce(r.cidr_ipv4, r.cidr_ipv6)}"]) == toset([
      "tcp/80/0.0.0.0/0", "tcp/80/::/0", "tcp/443/0.0.0.0/0", "tcp/443/::/0", "udp/443/0.0.0.0/0", "udp/443/::/0",
    ]) && length(aws_vpc_security_group_ingress_rule.web) == 6
    error_message = "Ingress must be exactly tcp 80, tcp 443 and udp 443, each from 0.0.0.0/0 and ::/0."
  }

  assert {
    condition = alltrue([for r in aws_vpc_security_group_ingress_rule.web :
    r.referenced_security_group_id == null && r.prefix_list_id == null])
    error_message = "Ingress sources are CIDRs only (no security group or prefix list)."
  }

  assert {
    condition     = aws_instance.app.vpc_security_group_ids == toset([aws_security_group.web.id])
    error_message = "The instance must use the web security group only."
  }
}

run "egress_all" {
  assert {
    condition     = aws_vpc_security_group_egress_rule.all_ipv4.ip_protocol == "-1" && aws_vpc_security_group_egress_rule.all_ipv4.cidr_ipv4 == "0.0.0.0/0"
    error_message = "Egress must allow everything (ECR, SSM, Let's Encrypt, apt, CloudWatch)."
  }
}

run "no_automatic_public_ip" {
  assert {
    condition     = !aws_subnet.public.map_public_ip_on_launch && !aws_instance.app.associate_public_ip_address
    error_message = "The Elastic IP must be the only public IPv4."
  }

  assert {
    condition     = aws_eip_association.app.instance_id == aws_instance.app.id && aws_eip_association.app.allocation_id == aws_eip.app.id
    error_message = "The Elastic IP must be attached to the instance."
  }
}
