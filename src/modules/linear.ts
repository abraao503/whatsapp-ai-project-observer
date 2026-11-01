import { config } from '../config.js';

interface GraphQlResult<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export interface LinearProject {
  name: string;
  linearTeamId: string;
  linearProjectId: string;
}

export interface LinearDemand {
  id: number;
  title: string;
  summary: string;
  demandType: string;
  status: string;
  requirements: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  conversationContext: string;
  technicalAnalysis: string;
  linearIssueId: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!config.linearApiKey) throw new Error('LINEAR_API_KEY não configurada');
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: config.linearApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000)
  });
  let payload: GraphQlResult<T>;
  try {
    payload = await response.json() as GraphQlResult<T>;
  } catch {
    throw new Error(`Linear respondeu HTTP ${response.status} sem JSON válido`);
  }
  if (!response.ok || payload.errors?.length) {
    const detail = payload.errors?.map((entry) => entry.message).filter(Boolean).join('; ');
    throw new Error(`Linear HTTP ${response.status}: ${(detail || 'falha GraphQL').slice(0, 500)}`);
  }
  if (!payload.data) throw new Error('Linear não retornou data GraphQL');
  return payload.data;
}

function markerFor(demandId: number): string {
  return `<!-- whatsapp-ai-project-observer:demand:${demandId} -->`;
}

function listSection(title: string, values: string[]): string {
  const items = values.map((value) => value.trim()).filter(Boolean);
  return items.length ? `### ${title}\n${items.map((value) => `- ${value}`).join('\n')}` : '';
}

function textSection(title: string, value: string): string {
  const text = value.trim();
  return text ? `### ${title}\n${text}` : '';
}

export function buildLinearDescription(demand: LinearDemand, project: LinearProject): string {
  const typeLabels: Record<string, string> = {
    feature: 'Funcionalidade',
    bug: 'Bug',
    improvement: 'Melhoria',
    change: 'Alteração'
  };
  const status = demand.status === 'cancelled'
    ? 'Cancelada'
    : demand.status === 'pending_context' ? 'Aguardando contexto' : 'Em acompanhamento';
  return [
    `### Projeto\n${project.name}`,
    `### Status\n${status}`,
    `### Tipo\n${typeLabels[demand.demandType] ?? demand.demandType}`,
    textSection('Objetivo e escopo', demand.summary),
    listSection('Requisitos', demand.requirements),
    listSection('Critérios de aceite', demand.acceptanceCriteria),
    listSection('Dúvidas pendentes', demand.openQuestions),
    textSection('Contexto e decisões', demand.conversationContext),
    textSection('Análise técnica (Codex)', demand.technicalAnalysis),
    markerFor(demand.id)
  ].filter(Boolean).join('\n\n');
}

async function findExistingIssue(
  demandId: number,
  project: LinearProject
): Promise<LinearIssue | null> {
  const query = `query FindObserverIssue($filter: IssueFilter!) {
    issues(filter: $filter, first: 10) {
      nodes { id identifier title url description }
    }
  }`;
  const filter: Record<string, unknown> = {
    team: { id: { eq: project.linearTeamId } },
    description: { contains: markerFor(demandId) }
  };
  if (project.linearProjectId) filter.project = { id: { eq: project.linearProjectId } };
  const data = await graphql<{
    issues: { nodes: Array<LinearIssue & { description: string | null }> };
  }>(query, { filter });
  const issue = data.issues.nodes.find((candidate) => candidate.description?.includes(markerFor(demandId)));
  if (!issue) return null;
  return { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };
}

export async function createOrUpdateIssue(
  demand: LinearDemand,
  project: LinearProject
): Promise<LinearIssue> {
  if (!project.linearTeamId) throw new Error(`O projeto ${project.name} não tem Linear Team ID`);
  const description = buildLinearDescription(demand, project);
  let issueId = demand.linearIssueId;
  if (!issueId) {
    const existing = await findExistingIssue(demand.id, project);
    if (existing) issueId = existing.id;
  }

  if (issueId) {
    const data = await graphql<{
      issueUpdate: { success: boolean; issue: LinearIssue | null };
    }>(
      `mutation UpdateObserverIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success issue { id identifier title url }
        }
      }`,
      { id: issueId, input: { title: demand.title, description } }
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new Error(`Linear não confirmou atualização da demanda ${demand.id}`);
    }
    return data.issueUpdate.issue;
  }

  const input: Record<string, unknown> = {
    teamId: project.linearTeamId,
    title: demand.title,
    description
  };
  if (project.linearProjectId) input.projectId = project.linearProjectId;
  const data = await graphql<{
    issueCreate: { success: boolean; issue: LinearIssue | null };
  }>(
    `mutation CreateObserverIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success issue { id identifier title url }
      }
    }`,
    { input }
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error(`Linear não confirmou criação da demanda ${demand.id}`);
  }
  return data.issueCreate.issue;
}
