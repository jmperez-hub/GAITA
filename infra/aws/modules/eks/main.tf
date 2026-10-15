# eks/main.tf
locals {
  cluster_name = "gaitas-${var.entorno}"
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueno            = var.dueno
  }
}

# IAM role for EKS control plane
resource "aws_iam_role" "eks_cluster" {
  name = "gaitas-eks-cluster-role-${var.entorno}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks_cluster.name
}

# EKS Cluster
resource "aws_eks_cluster" "gaitas" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = false
    security_group_ids      = [aws_security_group.eks_cluster.id]
  }

  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = var.kms_key_arn_plataforma
    }
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  tags       = local.tags
  depends_on = [aws_iam_role_policy_attachment.eks_cluster]
}

# OIDC provider for IRSA
data "tls_certificate" "eks" {
  url = aws_eks_cluster.gaitas.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.gaitas.identity[0].oidc[0].issuer
  tags            = local.tags
}

# Node group IAM role
resource "aws_iam_role" "node_group" {
  name = "gaitas-eks-nodes-${var.entorno}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  policy_arn = each.value
  role       = aws_iam_role.node_group.name
}

# Managed node group
resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.gaitas.name
  node_group_name = "gaitas-general-${var.entorno}"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.instance_types
  ami_type        = "AL2_x86_64"
  capacity_type   = "ON_DEMAND"

  scaling_config {
    desired_size = var.node_desired
    min_size     = var.node_min
    max_size     = var.node_max
  }

  update_config {
    max_unavailable = 1
  }

  launch_template {
    id      = aws_launch_template.nodes.id
    version = aws_launch_template.nodes.latest_version
  }

  labels = {
    proyecto = "gaitas"
    entorno  = var.entorno
  }

  tags       = local.tags
  depends_on = [aws_iam_role_policy_attachment.node_worker]
}

resource "aws_launch_template" "nodes" {
  name_prefix = "gaitas-nodes-${var.entorno}-"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.node_disk_gb
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = var.kms_key_arn_plataforma
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = local.tags
}

# Security group for EKS cluster
resource "aws_security_group" "eks_cluster" {
  name        = "gaitas-eks-cluster-sg-${var.entorno}"
  description = "SG del plano de control EKS GAITAS"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Todo el egreso"
  }

  tags = merge(local.tags, { Name = "gaitas-eks-cluster-sg" })
}

# IRSA role for cluster-autoscaler (Karpenter goes in P-09)
data "aws_iam_policy_document" "autoscaler_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:kube-system:cluster-autoscaler"]
    }
  }
}

resource "aws_iam_role" "cluster_autoscaler" {
  name               = "gaitas-cluster-autoscaler-${var.entorno}"
  assume_role_policy = data.aws_iam_policy_document.autoscaler_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "cluster_autoscaler" {
  name = "gaitas-autoscaler-policy"
  role = aws_iam_role.cluster_autoscaler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeScalingActivities",
        "autoscaling:DescribeTags",
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:DescribeInstanceTypes",
        "eks:DescribeNodegroup",
      ]
      Resource = "*"
    }]
  })
}
