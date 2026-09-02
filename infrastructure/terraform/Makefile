# Terraform workflow for infrastructure/terraform.
#
#   make fmt        format all .tf files in place
#   make fmt-check  fail if any file is not formatted (used in CI)
#   make validate   init without backend + validate (no AWS credentials needed)
#   make plan       plan against environments/$(ENV)/terraform.tfvars -> tfplan
#   make apply      apply the saved plan
#
# Secrets: export TF_VAR_admin_token and TF_VAR_token_secret instead of writing them to tfvars.

TF       ?= terraform
ENV      ?= prod
VAR_FILE ?= environments/$(ENV)/terraform.tfvars
PLAN     ?= tfplan

.PHONY: fmt fmt-check init validate plan apply destroy output clean

fmt:
	$(TF) fmt -recursive

fmt-check:
	$(TF) fmt -check -recursive -diff

init:
	$(TF) init -input=false

validate:
	$(TF) init -backend=false -input=false >/dev/null
	$(TF) validate

plan: init
	@test -f $(VAR_FILE) || { echo "missing $(VAR_FILE) — copy environments/$(ENV)/example.tfvars"; exit 1; }
	$(TF) plan -input=false -var-file=$(VAR_FILE) -out=$(PLAN)

apply:
	@test -f $(PLAN) || { echo "no $(PLAN) — run make plan first"; exit 1; }
	$(TF) apply -input=false $(PLAN)

destroy: init
	$(TF) destroy -var-file=$(VAR_FILE)

output:
	$(TF) output -json github_actions_variables

clean:
	rm -f $(PLAN)
