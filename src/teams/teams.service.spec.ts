import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import { TeamType } from '../utils/interface/team';
import { Team } from './schemas/team.schema';
import { TeamService } from './teams.service';

// Un objet équipe simulé
const mockTeam: TeamType = {
  uniqueId: 'NHL-BOS',
  label: 'Boston Bruins',
  league: 'NHL',
  wins: 10,
  losses: 5,
  otLosses: 2,
} as TeamType;

// Nous simulons uniquement les méthodes du modèle que nous utilisons dans les fonctions testées
const mockTeamModel = {
  findOneAndDelete: jest.fn(),
  deleteMany: jest.fn(),
  find: jest.fn(),
};

describe('TeamService', () => {
  let service: TeamService;
  let model: Model<Team>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        {
          provide: getModelToken(Team.name),
          useValue: mockTeamModel,
        },
      ],
    }).compile();

    service = module.get<TeamService>(TeamService);
    model = module.get<Model<Team>>(getModelToken(Team.name));

    // Réinitialiser les mocks avant chaque test
    jest.clearAllMocks();
  });

  it('devrait être défini', () => {
    expect(service).toBeDefined();
  });

  describe('addRecord', () => {
    it('devrait ajouter une chaîne de record avec victoires et défaites', () => {
      const team = { wins: 10, losses: 5 };
      const result = service['addRecord'](team);
      expect(result.record).toBe('10-5');
      expect(result.wins).toBe(10);
    });

    it('devrait ajouter une chaîne de record avec victoires, défaites et égalités', () => {
      const team = { wins: 10, losses: 5, ties: 2 };
      const result = service['addRecord'](team);
      expect(result.record).toBe('10-5-2');
    });

    it('devrait prioriser otLosses par rapport à ties', () => {
      const team = { wins: 10, losses: 5, ties: 2, otLosses: 3 };
      const result = service['addRecord'](team);
      expect(result.record).toBe('10-5-3');
    });

    it('devrait gérer les victoires/défaites non définies comme 0', () => {
      const team = { label: 'New Team' };
      const result = service['addRecord'](team);
      expect(result.record).toBe('0-0');
    });

    it("ne devrait pas ajouter d'égalité si la valeur est nulle ou non définie", () => {
      const teamWithNull = { wins: 10, losses: 5, ties: null };
      const resultWithNull = service['addRecord'](teamWithNull);
      expect(resultWithNull.record).toBe('10-5');

      const teamWithUndefined = { wins: 10, losses: 5, ties: undefined };
      const resultWithUndefined = service['addRecord'](teamWithUndefined);
      expect(resultWithUndefined.record).toBe('10-5');
    });
  });

  describe('remove', () => {
    it('devrait supprimer une équipe par son uniqueId et retourner le document supprimé', async () => {
      const uniqueId = 'NHL-BOS';
      // Simuler les appels en chaîne : findOneAndDelete(...).exec()
      (model.findOneAndDelete as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockTeam),
      });

      const result = await service.remove(uniqueId);

      expect(model.findOneAndDelete).toHaveBeenCalledWith({ uniqueId });
      expect(result).toEqual(mockTeam);
    });
  });

  describe('removeByLeague', () => {
    it("devrait supprimer toutes les équipes d'une ligue et retourner le résultat de l'opération", async () => {
      const league = 'NHL';
      const deleteResult = { deletedCount: 15, acknowledged: true };

      // Espionner console.log pour éviter de polluer la sortie des tests
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      // Simuler les appels en chaîne : deleteMany(...).exec()
      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleteResult),
      });

      const result = await service.removeByLeague(league);

      expect(model.deleteMany).toHaveBeenCalledWith({ league });
      expect(result).toEqual(deleteResult);
      expect(consoleSpy).toHaveBeenCalledWith(
        `Removing teams with league: ${league}`,
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        `Removed ${deleteResult.deletedCount} teams`,
      );

      // Restaurer console.log
      consoleSpy.mockRestore();
    });
  });

  describe('removeAll', () => {
    it('devrait appeler deleteMany et retourner le résultat', async () => {
      const deleteResult = { deletedCount: 20, acknowledged: true };
      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleteResult),
      });

      const result = await service.removeAll();

      // Vérifier que deleteMany a été appelé avec un objet vide
      expect(model.deleteMany).toHaveBeenCalledWith({});
      // Vérifier que find n'est plus appelé
      expect(model.find).not.toHaveBeenCalled();
      // Vérifier que le résultat de l'opération est bien retourné
      expect(result).toEqual(deleteResult);
    });
  });
});
