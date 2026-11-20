import { describe, expect, it } from 'vitest';
import { clientKey, parseCsvRecords, parseRepriseArticles, parseRepriseClients } from '../src/reprise.js';

describe('lecture CSV', () => {
  it('cellules entre guillemets sur plusieurs lignes, séparateur détecté', () => {
    const r = parseCsvRecords('﻿Nom;Description\r\n"Bureau";"Plateau rayé\nangle ""gauche"""\r\nChaise;\r\n\r\n');
    expect(r).toEqual([
      { line: 1, cells: ['Nom', 'Description'] },
      { line: 2, cells: ['Bureau', 'Plateau rayé\nangle "gauche"'] },
      { line: 4, cells: ['Chaise', ''] },
    ]);
    expect(parseCsvRecords('a,b\n1,2')[1]!.cells).toEqual(['1', '2']);
    expect(parseCsvRecords('a\tb\n1\t2')[1]!.cells).toEqual(['1', '2']);
  });
});

describe('reprise des articles', () => {
  const csv = [
    'Désignation;Nom technique;Code-barres;Client;Projet;Catégorie;Quantité;Emplacement;Longueur (cm);Largeur (cm);Hauteur (cm);Poids;État;Date de création;Photo;Colonne inutile',
    'Bureau direction;BUR-01;3700000000017;SAS Horizon;Les Tilleuls;Bureau;1;N-B-04-101;180;90;75;45,5;Bon état;03/02/2025;https://cdn.example/a.jpg https://cdn.example/b.jpg;x',
    'Chaise visiteur;CHA-01;;Horizon;;Chaise;6;;50;50;90;;neuf;;;',
    'Carton vide;CAR-01;;Horizon;;;0;;;;;;;;;',
    ';SANSNOM;;Horizon;;;1;;;;;;;;;',
    'Table;TAB-01;;Horizon;;;deux;;;;;;cassé;;;',
    'Doublon;BUR-01;3700000000017;Horizon;;;1;;;;;;;;;',
  ].join('\n');

  it('reconnaît les en-têtes Monstock et convertit les centimètres', () => {
    const r = parseRepriseArticles(csv);
    expect(r.colonnes).toMatchObject({ libelle: 'Désignation', reference: 'Nom technique', codeBarres: 'Code-barres', longueurCm: 'Longueur (cm)' });
    expect(r.ignorees).toEqual(['Colonne inutile']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      line: 2,
      libelle: 'Bureau direction',
      client: 'SAS Horizon',
      projet: 'Les Tilleuls',
      quantite: 1,
      emplacement: 'N-B-04-101',
      longueurM: 1.8,
      largeurM: 0.9,
      hauteurM: 0.75,
      poidsKg: 45.5,
      etat: 'BON',
      dateEntree: '2025-02-03T12:00:00.000Z',
      photos: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    });
    expect(r.rows[1]).toMatchObject({ libelle: 'Chaise visiteur', quantite: 6, etat: 'NEUF', projet: null });
  });

  it('signale chaque ligne fautive sans bloquer les autres ; quantité 0 ignorée', () => {
    const r = parseRepriseArticles(csv);
    expect(r.errors).toEqual([
      { line: 5, message: 'nom de l’objet manquant' },
      { line: 6, message: 'quantité « deux » invalide' },
      { line: 7, message: 'même code que la ligne 2' },
    ]);
  });

  it('client par défaut quand l’export ne concerne qu’un compte', () => {
    expect(parseRepriseArticles('Nom;Quantité\nBureau;2').errors[0]!.message).toMatch(/client/);
    const r = parseRepriseArticles('Nom;Quantité\nBureau;2', { clientParDefaut: 'Horizon' });
    expect(r.rows[0]).toMatchObject({ client: 'Horizon', quantite: 2, origine: 'horizon|bureau|L2' });
  });

  it('situation : en stock par défaut, chez le client, sorti ignoré', () => {
    const r = parseRepriseArticles('Nom;Client;Situation\nA;H;\nB;H;Chez le client\nC;H;Sorti\nD;H;Livré');
    expect(r.rows.map((x) => [x.libelle, x.situation])).toEqual([
      ['A', 'EN_STOCK'],
      ['B', 'RESTITUE'],
      ['D', 'RESTITUE'],
    ]);
  });

  it('refuse une quantité aberrante', () => {
    const r = parseRepriseArticles('Nom;Client;Stock\nVis;Horizon;12000');
    expect(r.errors[0]!.message).toMatch(/supérieure à 500/);
  });
});

describe('reprise des comptes clients', () => {
  it('type déduit, e-mails contrôlés', () => {
    const r = parseRepriseClients(
      [
        'Société;Type;SIRET;Contact;E-mail;Téléphone;Projets',
        'Horizon;Professionnel;123 456 789 00012;Mme Durand;DSG@Horizon.fr;0601020304;Les Tilleuls, Les Jardins',
        'Camille Martin;Particulier;;;camille@exemple;;',
        'Bâtir;;;;dsg@horizon.fr;;',
      ].join('\n'),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      client: 'Horizon',
      type: 'B2B',
      siret: '12345678900012',
      email: 'dsg@horizon.fr',
      projets: ['Les Tilleuls', 'Les Jardins'],
    });
    expect(r.errors).toEqual([
      { line: 3, message: 'e-mail « camille@exemple » invalide' },
      { line: 4, message: 'e-mail déjà utilisé ligne 2' },
    ]);
  });

  it('rapproche les noms malgré la forme juridique', () => {
    expect(clientKey('SAS Horizon')).toBe(clientKey('horizon'));
    expect(clientKey('Bâtir Ensemble SARL')).toBe('batir_ensemble');
  });
});
