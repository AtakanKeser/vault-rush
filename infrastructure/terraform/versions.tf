terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # ------------------------------------------------------------------------------------
  # Remote state (S3 + DynamoDB lock). Disabled by default so `terraform init -backend=false`
  # and `terraform validate` work without AWS access. To enable:
  #
  #   1. Bootstrap the state resources once (outside this configuration):
  #        aws s3api create-bucket --bucket vault-rush-terraform-state --region eu-central-1 \
  #          --create-bucket-configuration LocationConstraint=eu-central-1
  #        aws s3api put-bucket-versioning --bucket vault-rush-terraform-state \
  #          --versioning-configuration Status=Enabled
  #        aws s3api put-public-access-block --bucket vault-rush-terraform-state \
  #          --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  #        aws dynamodb create-table --table-name vault-rush-terraform-locks \
  #          --attribute-definitions AttributeName=LockID,AttributeType=S \
  #          --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
  #
  #   2. Uncomment the block below and run `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket         = "vault-rush-terraform-state"
  #   key            = "prod/terraform.tfstate"
  #   region         = "eu-central-1"
  #   dynamodb_table = "vault-rush-terraform-locks"
  #   encrypt        = true
  # }
  # ------------------------------------------------------------------------------------
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# CloudFront only accepts ACM certificates issued in us-east-1, regardless of where the
# rest of the stack lives. The static module receives the certificate ARN as a variable,
# so this alias exists for future us-east-1 resources (e.g. issuing that certificate here).
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}
